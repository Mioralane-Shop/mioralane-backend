/**
 * P1.2 — image upload validation.
 *
 * Run with: npm run verify:file-upload
 *
 * Every request-level check drives the REAL pipeline: `createSingleFileUpload`
 * (the same factory both routes use, so the same multer configuration the
 * application runs) followed by the real `requireImageUpload()` guard, over a
 * real HTTP multipart request. Nothing here re-implements the checks it is
 * verifying.
 *
 * ## The boundary, stated up front
 *
 * The media route sits behind `adminGuard`, and `protect` re-reads the account's
 * role from MongoDB on every request — so with `skipDatabaseCheck: true` there
 * is no way to reach the controller over HTTP without a database. This harness
 * therefore exercises the pipeline plus a route that mirrors the controller's
 * post-P1.2 contract exactly (`readUploadedFile` / `readImageMimeType`, both
 * fail-closed), and asserts the real route's wiring **statically** (check C1).
 * Full-chain coverage for this route is not claimed.
 *
 * ## What this block actually changed
 *
 * The recon found the magic-byte check, the filename policy and the extension
 * derivation already existed and already worked. So the checks below are not
 * "does it validate" — they are about the two things P1.2 did change: the
 * allowlist (GIF is now refused, and the message and behaviour finally agree) and
 * the placement (the decision moved out of a service method and into a route-level
 * guard that a future route cannot skip).
 *
 * Exits non-zero if any check fails.
 */
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import express, { type Request, type RequestHandler, type Response } from 'express';
import { errorHandler, notFoundHandler, requestId } from '../src/middleware/error.middleware';
import { createSingleFileUpload } from '../src/middleware/multipart-upload';
import {
    EMPTY_IMAGE_MESSAGE,
    MISSING_IMAGE_MESSAGE,
    UNSUPPORTED_IMAGE_MESSAGE,
    readImageMimeType,
    readUploadedFile,
    requireImageUpload,
} from '../src/middleware/upload-validator.middleware';
import {
    MAX_MEDIA_UPLOAD_SIZE_BYTES,
    MEDIA_IMAGE_MIME_ALLOWLIST,
    MIME_TO_EXTENSION,
    buildImageFileName,
    detectImageMimeType,
    isAllowedImageMimeType,
    sanitizeImageBaseName,
} from '../src/media/image-upload-policy';

const SRC_DIR = join(__dirname, '..', 'src');
const MEDIA_ROUTES_FILE = join(SRC_DIR, 'media', 'media.routes.ts');
const MEDIA_CONTROLLER_FILE = join(SRC_DIR, 'media', 'media.controller.ts');
const IMAGEKIT_ROUTES_FILE = join(SRC_DIR, 'imagekit', 'imagekit.module.ts');
const IMAGEKIT_SERVICE_FILE = join(SRC_DIR, 'imagekit', 'imagekit.service.ts');
const POLICY_FILE = join(SRC_DIR, 'media', 'image-upload-policy.ts');
const MULTIPART_FILE = join(SRC_DIR, 'middleware', 'multipart-upload.ts');
const UPLOAD_VALIDATOR_FILE = join(SRC_DIR, 'middleware', 'upload-validator.middleware.ts');

/** Matches the wording the media route has always returned. */
const MEDIA_TOO_LARGE_MESSAGE = 'File exceeds the 8MB upload limit';

const failures: string[] = [];

const check = (label: string, condition: boolean, detail?: string): void => {
    if (condition) {
        console.log(`  OK   ${label}`);
        return;
    }

    const suffix = detail ? ` — ${detail}` : '';
    console.log(`  FAIL ${label}${suffix}`);
    failures.push(`${label}${suffix}`);
};

const section = (title: string): void => {
    console.log(`\n=== ${title} ===`);
};

/** Strips comment-ONLY lines so structural assertions read code, not prose. */
const stripCommentLines = (source: string): string =>
    source
        .split('\n')
        .filter((line) => {
            const trimmed = line.trim();

            return !(
                trimmed.startsWith('//') ||
                trimmed.startsWith('*') ||
                trimmed.startsWith('/*') ||
                trimmed.startsWith('*/')
            );
        })
        .join('\n');

const readSource = (file: string): string => stripCommentLines(readFileSync(file, 'utf8'));

/* ──────────────────────────── byte fixtures ──────────────────────────── */

const filler = (length: number): Buffer => Buffer.alloc(length, 0x2a);

/** Real 8-byte PNG signature + a plausible IHDR start. */
const PNG_BYTES = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from('IHDR', 'ascii'),
    filler(64),
]);

/** Real JPEG SOI marker (FF D8 FF) + an APP0/JFIF segment start. */
const JPEG_BYTES = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'ascii'),
    filler(64),
]);

/** Real RIFF container with the WEBP form type at the exact offset. */
const WEBP_BYTES = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x40, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
    Buffer.from('VP8 ', 'ascii'),
    filler(64),
]);

const GIF_BYTES = Buffer.concat([Buffer.from('GIF89a', 'ascii'), filler(64)]);

const SVG_BYTES = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    'utf8'
);

const TEXT_BYTES = Buffer.from('#!/bin/sh\necho not an image\n', 'utf8');

const PNG_HEADER_ONLY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A PNG signature that stops after 4 bytes, followed by WebP content.
 *
 * This is the honest version of "PNG header but WebP content": a *complete* PNG
 * prefix would legitimately be detected as PNG (a prefix check cannot see past
 * the prefix). Only a partial signature leaves nothing matching.
 */
const HALF_PNG_THEN_WEBP = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    WEBP_BYTES,
]);

/* ──────────────────────────── probe pipeline ──────────────────────────── */

type ProbeResponse = {
    status: number;
    body: unknown;
    text: string;
};

const listen = async (app: express.Application): Promise<Server> =>
    new Promise<Server>((resolve) => {
        const server = app.listen(0, () => resolve(server));
    });

const portOf = (server: Server): number => {
    const address = server.address();

    return address !== null && typeof address === 'object' ? address.port : 0;
};

const envelopeOf = (body: unknown): { success?: unknown; message?: unknown } =>
    typeof body === 'object' && body !== null ? (body as { success?: unknown; message?: unknown }) : {};

const dataOf = (body: unknown): Record<string, unknown> => {
    if (typeof body !== 'object' || body === null) {
        return {};
    }

    const data = (body as { data?: unknown }).data;

    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
};

/** Counts how often the route handler was reached, per probe app. */
const handlerHits = { guarded: 0, unguarded: 0 };

/**
 * The probe route mirrors `MediaController.uploadWithAssetType` after P1.2:
 * read the file, read the type the guard established, and **refuse when it is
 * absent** — that fail-closed branch is what makes a forgotten middleware a
 * refused upload rather than an unchecked one.
 */
const buildProbeApp = (options: { withGuard: boolean; maxBytes?: number; counter: keyof typeof handlerHits }): express.Application => {
    const app = express();

    app.use(requestId);

    const handlers: RequestHandler[] = [
        createSingleFileUpload({
            maxBytes: options.maxBytes ?? MAX_MEDIA_UPLOAD_SIZE_BYTES,
            tooLargeMessage: MEDIA_TOO_LARGE_MESSAGE,
        }),
    ];

    if (options.withGuard) {
        handlers.push(requireImageUpload());
    }

    handlers.push((req: Request, res: Response) => {
        handlerHits[options.counter] += 1;

        const file = readUploadedFile(req);

        if (!file) {
            res.status(400).json({ success: false, message: MISSING_IMAGE_MESSAGE });
            return;
        }

        if ((file.buffer?.length ?? 0) <= 0) {
            res.status(400).json({ success: false, message: EMPTY_IMAGE_MESSAGE });
            return;
        }

        const mimeType = readImageMimeType(req);

        if (mimeType === undefined) {
            res.status(400).json({ success: false, message: UNSUPPORTED_IMAGE_MESSAGE });
            return;
        }

        res.status(201).json({
            success: true,
            data: {
                mimeType,
                declaredMimeType: file.mimetype,
                storedName: buildImageFileName('mioralane-product', file.originalname, mimeType),
                byteLength: file.buffer.length,
            },
        });
    });

    app.post('/probe', ...handlers);
    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
};

type UploadOptions = {
    bytes: Buffer;
    filename: string;
    declaredType: string;
    field?: string;
    omitFile?: boolean;
    /**
     * Extra non-file parts, appended before the file. Needed to exercise the
     * parser's *field-name* limits: `fieldNestingDepth` and `fieldArrayIndexLimit`
     * are checked while parsing a text part, so sending the crafted name as the
     * file's field name only ever hits `.single()`'s LIMIT_UNEXPECTED_FILE.
     */
    extraFields?: { name: string; value: string }[];
};

const uploadProbe = async (port: number, options: UploadOptions): Promise<ProbeResponse> => {
    const form = new FormData();

    for (const extra of options.extraFields ?? []) {
        form.append(extra.name, extra.value);
    }

    if (!options.omitFile) {
        // `new Uint8Array(...)` rather than the Buffer directly: Node's `Buffer`
        // is not assignable to the DOM `BlobPart` type without it.
        form.append(
            options.field ?? 'file',
            new Blob([new Uint8Array(options.bytes)], { type: options.declaredType }),
            options.filename
        );
    }

    const response = await fetch(`http://127.0.0.1:${port}/probe`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();

    let body: unknown = null;

    try {
        body = JSON.parse(text);
    } catch {
        body = null;
    }

    return { status: response.status, body, text };
};

const isUnsupported = (response: ProbeResponse): boolean =>
    response.status === 400 && envelopeOf(response.body).message === UNSUPPORTED_IMAGE_MESSAGE;

/* ───────────────────────────── checks ───────────────────────────── */

const main = async (): Promise<void> => {
    /* ── A. the policy, as pure functions ─────────────────────────────── */
    section('A. The allowlist and the sniffer');

    check(
        'the allowlist is exactly JPEG, PNG and WebP',
        MEDIA_IMAGE_MIME_ALLOWLIST.length === 3 &&
            MEDIA_IMAGE_MIME_ALLOWLIST.includes('image/jpeg') &&
            MEDIA_IMAGE_MIME_ALLOWLIST.includes('image/png') &&
            MEDIA_IMAGE_MIME_ALLOWLIST.includes('image/webp'),
        MEDIA_IMAGE_MIME_ALLOWLIST.join(', ')
    );
    check(
        'GIF is not in the allowlist (the block’s one behaviour change)',
        !(MEDIA_IMAGE_MIME_ALLOWLIST as readonly string[]).includes('image/gif'),
        MEDIA_IMAGE_MIME_ALLOWLIST.join(', ')
    );
    check(
        'every allowlist member maps to an extension, and none is dangerous',
        MEDIA_IMAGE_MIME_ALLOWLIST.every((mime) => /^\.(jpg|png|webp)$/.test(MIME_TO_EXTENSION[mime])) &&
            Object.values(MIME_TO_EXTENSION).every((ext) => !/\.(php|svg|html|js)$/.test(ext)),
        Object.values(MIME_TO_EXTENSION).join(', ')
    );

    const signatureMatrix: Array<[string, Buffer, string | null]> = [
        ['PNG', PNG_BYTES, 'image/png'],
        ['JPEG', JPEG_BYTES, 'image/jpeg'],
        ['WebP', WEBP_BYTES, 'image/webp'],
        ['GIF', GIF_BYTES, null],
        ['SVG', SVG_BYTES, null],
        ['a shell script', TEXT_BYTES, null],
        ['an empty buffer', Buffer.alloc(0), null],
        ['a 3-byte JPEG prefix', Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
        ['PNG truncated to 4 bytes then WebP', HALF_PNG_THEN_WEBP, null],
    ];

    for (const [label, bytes, expected] of signatureMatrix) {
        check(
            `the sniffer classifies ${label} as ${String(expected)}`,
            detectImageMimeType(bytes) === expected,
            `got ${String(detectImageMimeType(bytes))}`
        );
    }

    check(
        'a PNG signature with one byte changed is not PNG (the whole signature is read)',
        detectImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x0d, 0x0a, 0x1a, 0x0a])) === null,
        'a partial signature passed'
    );
    check(
        'a JPEG marker with a wrong third byte is not JPEG',
        detectImageMimeType(Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xff])) === null,
        'a two-byte prefix was accepted as JPEG'
    );
    check(
        'RIFF without the WEBP form type at offset 8 is not WebP',
        detectImageMimeType(
            Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('AVI ', 'ascii')])
        ) === null,
        'a RIFF container was accepted without the form type'
    );

    check(
        'isAllowedImageMimeType accepts the three formats and nothing else',
        isAllowedImageMimeType('image/jpeg') &&
            isAllowedImageMimeType('image/webp') &&
            !isAllowedImageMimeType('image/gif') &&
            !isAllowedImageMimeType('image/svg+xml') &&
            !isAllowedImageMimeType('image/jpg') &&
            !isAllowedImageMimeType(undefined) &&
            !isAllowedImageMimeType(null) &&
            !isAllowedImageMimeType(123),
        'the narrowing helper is not strict'
    );

    /* ── B. the name policy ───────────────────────────────────────────── */
    section('B. The stored file name');

    check(
        'the sanitizer keeps only the allowed charset, removes separators and never leads with a dash',
        sanitizeImageBaseName('../../../etc/passwd') === '..-..-etc-passwd' &&
            !sanitizeImageBaseName('../../../etc/passwd').includes('/') &&
            !sanitizeImageBaseName('../../../etc/passwd').startsWith('-'),
        sanitizeImageBaseName('../../../etc/passwd')
    );
    check(
        'separators, spaces and unicode collapse to the allowed charset',
        /^[a-z0-9.-]+$/.test(sanitizeImageBaseName('  ../../Évil Fïle Name?.PNG  ')),
        sanitizeImageBaseName('  ../../Évil Fïle Name?.PNG  ')
    );
    check(
        'a name that reduces to nothing becomes a fixed placeholder',
        sanitizeImageBaseName('...') === 'image' && sanitizeImageBaseName('/') === 'image',
        `"..." -> ${sanitizeImageBaseName('...')}`
    );

    const traversed = buildImageFileName('mioralane-product', '../../../etc/passwd', 'image/png');

    check(
        'a stored name carries no directory component and no traversal',
        !traversed.includes('/') && !traversed.includes('..') && traversed.startsWith('mioralane-product-passwd-'),
        traversed
    );

    const doubleExtension = buildImageFileName('mioralane-product', 'file.jpg.php', 'image/png');

    check(
        'a double extension cannot survive: the extension comes from the bytes',
        doubleExtension.endsWith('.png') && !doubleExtension.includes('.php'),
        doubleExtension
    );
    check(
        'the same bytes sent as photo.jpg are stored as .webp, not .jpg',
        buildImageFileName('mioralane-product', 'photo.jpg', 'image/webp').endsWith('.webp'),
        buildImageFileName('mioralane-product', 'photo.jpg', 'image/webp')
    );
    check(
        'two names built from the same input differ (nothing is overwritten)',
        buildImageFileName('p', 'a.png', 'image/png') !== buildImageFileName('p', 'a.png', 'image/png'),
        'the unique suffix is missing'
    );
    check(
        'a very long name is capped and cannot end in a separator',
        (() => {
            const long = buildImageFileName('mioralane-product', `${'a'.repeat(400)}.png`, 'image/png');

            return long.length < 200 && !/[.-]{2,}/.test(long) && !/[.-]$/.test(long.replace(/\.[a-z]+$/, ''));
        })(),
        `length ${buildImageFileName('mioralane-product', `${'a'.repeat(400)}.png`, 'image/png').length}`
    );

    /* ── C. end-to-end through the real pipeline ──────────────────────── */
    section('C. Real multipart requests through the real pipeline');

    const guarded = await listen(buildProbeApp({ withGuard: true, counter: 'guarded' }));

    try {
        const port = portOf(guarded);

        for (const [label, bytes, filename, expectedMime, expectedExt] of [
            ['JPEG', JPEG_BYTES, 'photo.jpg', 'image/jpeg', '.jpg'],
            ['PNG', PNG_BYTES, 'photo.png', 'image/png', '.png'],
            ['WebP', WEBP_BYTES, 'photo.webp', 'image/webp', '.webp'],
        ] as Array<[string, Buffer, string, string, string]>) {
            const response = await uploadProbe(port, { bytes, filename, declaredType: expectedMime });

            check(
                `a real ${label} upload is accepted`,
                response.status === 201 && dataOf(response.body).mimeType === expectedMime,
                `status ${response.status} body ${response.text.slice(0, 90)}`
            );
            check(
                `the stored ${label} name ends ${expectedExt}`,
                String(dataOf(response.body).storedName ?? '').endsWith(expectedExt),
                String(dataOf(response.body).storedName ?? '')
            );
        }

        const textAsJpg = await uploadProbe(port, {
            bytes: TEXT_BYTES,
            filename: 'innocent.jpg',
            declaredType: 'image/jpeg',
        });

        check(
            'a text file named .jpg and declared image/jpeg is refused',
            isUnsupported(textAsJpg),
            `status ${textAsJpg.status} body ${textAsJpg.text.slice(0, 90)}`
        );
        check(
            'the refusal keeps the { success, message } envelope',
            envelopeOf(textAsJpg.body).success === false,
            textAsJpg.text.slice(0, 90)
        );

        const halfPng = await uploadProbe(port, {
            bytes: HALF_PNG_THEN_WEBP,
            filename: 'confused.png',
            declaredType: 'image/png',
        });

        check(
            'a partial PNG signature followed by WebP content matches nothing and is refused',
            isUnsupported(halfPng),
            `status ${halfPng.status}`
        );

        const headerOnly = await uploadProbe(port, {
            bytes: PNG_HEADER_ONLY,
            filename: 'header-only.png',
            declaredType: 'image/png',
        });

        check(
            'an 8-byte PNG header alone is accepted (a signature check is not a decoder)',
            headerOnly.status === 201,
            `status ${headerOnly.status} — if this ever changes, the documented limitation changed too`
        );

        const traversal = await uploadProbe(port, {
            bytes: PNG_BYTES,
            filename: '../../../etc/passwd',
            declaredType: 'image/png',
        });
        const traversalName = String(dataOf(traversal.body).storedName ?? '');

        check(
            'a traversal filename is accepted but stored without any path',
            traversal.status === 201 && !traversalName.includes('/') && !traversalName.includes('..'),
            `${traversal.status} ${traversalName}`
        );

        const doubleExt = await uploadProbe(port, {
            bytes: PNG_BYTES,
            filename: 'file.jpg.php',
            declaredType: 'image/png',
        });
        const doubleExtName = String(dataOf(doubleExt.body).storedName ?? '');

        check(
            'file.jpg.php cannot produce a .php stored file',
            doubleExt.status === 201 && doubleExtName.endsWith('.png') && !doubleExtName.includes('.php'),
            doubleExtName
        );

        const longName = await uploadProbe(port, {
            bytes: JPEG_BYTES,
            filename: `${'x'.repeat(300)}.jpg`,
            declaredType: 'image/jpeg',
        });
        const longStored = String(dataOf(longName.body).storedName ?? '');

        check(
            'a 300-character name produces a clean, bounded stored name',
            longName.status === 201 && /^[a-z0-9.-]+$/.test(longStored) && longStored.length < 200,
            `${longName.status} ${longStored.length} chars`
        );

        const oddName = await uploadProbe(port, {
            bytes: JPEG_BYTES,
            filename: 'weird name (1) — ünïcode!.jpg',
            declaredType: 'image/jpeg',
        });
        const oddStored = String(dataOf(oddName.body).storedName ?? '');

        check(
            'spaces, punctuation and unicode in a name produce a clean stored name',
            oddName.status === 201 && /^[a-z0-9.-]+$/.test(oddStored),
            `${oddName.status} ${oddStored}`
        );

        const nullName = await uploadProbe(port, {
            bytes: JPEG_BYTES,
            filename: 'bad\0name.jpg',
            declaredType: 'image/jpeg',
        });

        check(
            'a NUL byte in the filename never reaches the pipeline (the multipart parser refuses it)',
            nullName.status === 400,
            `${nullName.status} ${nullName.text.slice(0, 60)} — pre-existing behaviour, unchanged by P1.2`
        );

        const declaredAsPng = await uploadProbe(port, {
            bytes: WEBP_BYTES,
            filename: 'actually-webp.png',
            declaredType: 'image/png',
        });

        check(
            'the declared type is ignored: WebP bytes declared as image/png are stored as WebP',
            declaredAsPng.status === 201 && dataOf(declaredAsPng.body).mimeType === 'image/webp',
            `status ${declaredAsPng.status} mime ${String(dataOf(declaredAsPng.body).mimeType)}`
        );
        check(
            'and the client’s declaration is still reported back untouched for the audit trail',
            dataOf(declaredAsPng.body).declaredMimeType === 'image/png',
            String(dataOf(declaredAsPng.body).declaredMimeType)
        );

        const declaredAsSvg = await uploadProbe(port, {
            bytes: SVG_BYTES,
            filename: 'vector.png',
            declaredType: 'image/png',
        });

        check(
            'SVG bytes declared as image/png are refused — content wins over declaration',
            isUnsupported(declaredAsSvg),
            `status ${declaredAsSvg.status}`
        );

        const gif = await uploadProbe(port, { bytes: GIF_BYTES, filename: 'loop.gif', declaredType: 'image/gif' });

        check(
            'GIF is refused (behaviour now matches the message)',
            isUnsupported(gif),
            `status ${gif.status} body ${gif.text.slice(0, 90)}`
        );

        const svg = await uploadProbe(port, {
            bytes: SVG_BYTES,
            filename: 'evil.svg',
            declaredType: 'image/svg+xml',
        });

        check('SVG is refused', isUnsupported(svg), `status ${svg.status}`);

        const wrongField = await uploadProbe(port, {
            bytes: PNG_BYTES,
            filename: 'photo.png',
            declaredType: 'image/png',
            field: 'image',
        });

        check(
            'a file sent under a different field name is refused by multer (its own 400, not a silent pass)',
            wrongField.status === 400 &&
                typeof envelopeOf(wrongField.body).message === 'string' &&
                String(envelopeOf(wrongField.body).message).length > 0,
            `${wrongField.status} ${wrongField.text.slice(0, 80)}`
        );

        const emptyFile = await uploadProbe(port, {
            bytes: Buffer.alloc(0),
            filename: 'empty.png',
            declaredType: 'image/png',
        });

        check(
            'an empty file part is refused with the empty-upload message',
            emptyFile.status === 400 && envelopeOf(emptyFile.body).message === EMPTY_IMAGE_MESSAGE,
            `${emptyFile.status} ${emptyFile.text.slice(0, 80)}`
        );

        const noFile = await uploadProbe(port, { bytes: PNG_BYTES, filename: 'x.png', declaredType: 'image/png', omitFile: true });

        check(
            'a request with no file part is refused with the missing-file message',
            noFile.status === 400 && envelopeOf(noFile.body).message === MISSING_IMAGE_MESSAGE,
            `${noFile.status} ${noFile.text.slice(0, 80)}`
        );
    } finally {
        guarded.close();
    }

    /* ── D. the size ceiling ──────────────────────────────────────────── */
    section('D. Size limits (unchanged)');

    const smallLimit = await listen(
        buildProbeApp({ withGuard: true, maxBytes: 1024, counter: 'guarded' })
    );

    try {
        const response = await uploadProbe(portOf(smallLimit), {
            bytes: Buffer.concat([PNG_BYTES, filler(2048)]),
            filename: 'big.png',
            declaredType: 'image/png',
        });

        check(
            'a body over the configured ceiling is refused with 413 and the route’s wording',
            response.status === 413 && envelopeOf(response.body).message === MEDIA_TOO_LARGE_MESSAGE,
            `${response.status} ${response.text.slice(0, 80)}`
        );
    } finally {
        smallLimit.close();
    }

    const bigOversize = await listen(buildProbeApp({ withGuard: true, counter: 'guarded' }));

    try {
        const response = await uploadProbe(portOf(bigOversize), {
            bytes: Buffer.concat([PNG_BYTES, filler(MAX_MEDIA_UPLOAD_SIZE_BYTES + 4096)]),
            filename: 'too-big.png',
            declaredType: 'image/png',
        });

        check(
            'the real 8MB ceiling refuses a body over 8MB with 413',
            response.status === 413 && envelopeOf(response.body).message === MEDIA_TOO_LARGE_MESSAGE,
            `${response.status} ${response.text.slice(0, 80)}`
        );
        check(
            'the 8MB ceiling is still 8MB',
            MAX_MEDIA_UPLOAD_SIZE_BYTES === 8 * 1024 * 1024,
            String(MAX_MEDIA_UPLOAD_SIZE_BYTES)
        );
    } finally {
        bigOversize.close();
    }

    /* ── D2. the multipart field-name limits (P1.6.4) ─────────────────── */
    section('D2. Field-name limits (no nesting, no array indices)');

    const fieldLimits = await listen(buildProbeApp({ withGuard: true, counter: 'guarded' }));

    try {
        const port = portOf(fieldLimits);

        const plain = await uploadProbe(port, {
            bytes: PNG_BYTES,
            filename: 'plain.png',
            declaredType: 'image/png',
        });

        check(
            'the plain `file` field still uploads (depth 0 does not break the real client)',
            plain.status === 201 && envelopeOf(plain.body).success === true,
            `${plain.status} ${plain.text.slice(0, 80)}`
        );

        const nested = await uploadProbe(port, {
            bytes: PNG_BYTES,
            filename: 'nested.png',
            declaredType: 'image/png',
            extraFields: [{ name: 'items[0]', value: 'x' }],
        });

        check(
            'a nested text field name is refused with 400, not accepted',
            nested.status === 400,
            `${nested.status} ${nested.text.slice(0, 80)}`
        );
        check(
            'and it is refused for the nesting reason specifically (multer LIMIT_FIELD_NESTING)',
            envelopeOf(nested.body).message === 'Field name nesting too deep',
            `${JSON.stringify(envelopeOf(nested.body).message)}`
        );

        const hugeIndex = await uploadProbe(port, {
            bytes: PNG_BYTES,
            filename: 'index.png',
            declaredType: 'image/png',
            extraFields: [{ name: 'items[4294967294]', value: 'x' }],
        });

        check(
            'the oversized-array-index shape is refused too (GHSA-535w-7cp7-47q4)',
            hugeIndex.status === 400,
            `${hugeIndex.status} ${hugeIndex.text.slice(0, 80)}`
        );
        check(
            'at depth 0 it is the nesting limit that fires, so fieldArrayIndexLimit is the second layer',
            envelopeOf(hugeIndex.body).message === 'Field name nesting too deep',
            `${JSON.stringify(envelopeOf(hugeIndex.body).message)}`
        );
        check(
            'neither refusal is a 500 — multer errors stay mapped to 400',
            nested.status !== 500 && hugeIndex.status !== 500,
            `${nested.status} / ${hugeIndex.status}`
        );
    } finally {
        fieldLimits.close();
    }

    /* ── E. negative controls ─────────────────────────────────────────── */
    section('E. Negative controls');

    const twin = await listen(buildProbeApp({ withGuard: false, counter: 'unguarded' }));

    try {
        const port = portOf(twin);
        const validOnTwin = await uploadProbe(port, {
            bytes: JPEG_BYTES,
            filename: 'photo.jpg',
            declaredType: 'image/jpeg',
        });
        const fakeOnTwin = await uploadProbe(port, {
            bytes: TEXT_BYTES,
            filename: 'innocent.jpg',
            declaredType: 'image/jpeg',
        });

        check(
            'NC1: without the guard the pipeline refuses even a valid JPEG (fails closed, never open)',
            validOnTwin.status === 400 && envelopeOf(validOnTwin.body).message === UNSUPPORTED_IMAGE_MESSAGE,
            `${validOnTwin.status} ${validOnTwin.text.slice(0, 80)}`
        );
        check(
            'NC1: and it cannot tell the fake JPEG from the real one — the guard is what makes the decision',
            fakeOnTwin.status === 400,
            `${fakeOnTwin.status}`
        );
        check(
            'NC1: removing the guard can never turn into a silent pass',
            validOnTwin.status !== 201 && fakeOnTwin.status !== 201,
            'a route missing the guard accepted an upload'
        );
    } finally {
        twin.close();
    }

    const counterProbe = await listen(buildProbeApp({ withGuard: true, counter: 'guarded' }));

    try {
        const before = handlerHits.guarded;

        await uploadProbe(portOf(counterProbe), {
            bytes: GIF_BYTES,
            filename: 'loop.gif',
            declaredType: 'image/gif',
        });
        await uploadProbe(portOf(counterProbe), {
            bytes: PNG_BYTES,
            filename: 'photo.png',
            declaredType: 'image/png',
        });

        const after = handlerHits.guarded;

        check(
            'NC2: the guard rejects before the route handler runs (the handler is never reached for a bad file)',
            after - before === 1,
            `${after - before} handler calls for 2 requests`
        );
    } finally {
        counterProbe.close();
    }

    /* ── F. wiring and hygiene (source-level) ─────────────────────────── */
    section('F. Wiring and hygiene');

    const mediaRoutes = readSource(MEDIA_ROUTES_FILE);
    const mediaController = readSource(MEDIA_CONTROLLER_FILE);
    const imagekitRoutes = readSource(IMAGEKIT_ROUTES_FILE);
    const imagekitService = readSource(IMAGEKIT_SERVICE_FILE);
    const multipartSource = readSource(MULTIPART_FILE);
    const policySource = readSource(POLICY_FILE);
    const uploadValidatorSource = readSource(UPLOAD_VALIDATOR_FILE);

    const validateIndex = mediaRoutes.indexOf('validate({ body: mediaUploadSchema');
    const guardIndex = mediaRoutes.indexOf('requireImageUpload()');
    const controllerIndex = mediaRoutes.indexOf('mediaController.uploadImage(req, res)');

    check(
        'C1: the media route mounts the guard after multer+validate and before the controller',
        validateIndex !== -1 && guardIndex !== -1 && controllerIndex !== -1 &&
            guardIndex > validateIndex && guardIndex < controllerIndex,
        `validate@${validateIndex} guard@${guardIndex} controller@${controllerIndex}`
    );
    check(
        'the dev-only test route mounts the same guard',
        imagekitRoutes.includes('requireImageUpload()'),
        'the test route has no content guard'
    );
    check(
        'a forgotten guard is a refusal, never a pass (controllers read the decision and fail closed)',
        mediaController.includes('readImageMimeType(req)') &&
            mediaController.includes('detectedMimeType === undefined') &&
            // The guard is the only thing that sets this field; code, not prose.
            uploadValidatorSource.includes('imageMimeType = detectedMimeType') &&
            uploadValidatorSource.includes('imageMimeType?: SupportedImageMimeType'),
        'the controller does not fail closed when the guard is absent'
    );

    check(
        'GIF is gone from the whole backend, not just the allowlist',
        !/image\/gif/i.test(policySource) &&
            !/image\/gif/i.test(mediaController) &&
            !/image\/gif/i.test(imagekitService) &&
            !/image\/gif/i.test(uploadValidatorSource),
        'an image/gif reference survives'
    );
    check(
        'the dead MIME_TYPE_TO_EXTENSION map (which listed .svg) is gone',
        !/MIME_TYPE_TO_EXTENSION/.test(imagekitService) &&
            !/\.svg/.test(policySource) &&
            !/\.svg/.test(imagekitService),
        'a .svg extension mapping survives'
    );

    check(
        'multer is configured in exactly one module (G6 consolidation)',
        /multer\(/.test(multipartSource) &&
            !/multer\(/.test(mediaRoutes) &&
            !/multer\(/.test(imagekitRoutes),
        'a route still builds its own multer instance'
    );
    check(
        'both routes get their upload handler from the shared factory',
        mediaRoutes.includes("from '../middleware/multipart-upload'") &&
            imagekitRoutes.includes("from '../middleware/multipart-upload'") &&
            mediaRoutes.includes('createSingleFileUpload({') &&
            imagekitRoutes.includes('createSingleFileUpload({'),
        'a route does not use the factory'
    );
    check(
        'each route still passes its own limit and its own 413 wording explicitly',
        mediaRoutes.includes('maxBytes: MAX_MEDIA_UPLOAD_SIZE_BYTES') &&
            mediaRoutes.includes("tooLargeMessage: 'File exceeds the 8MB upload limit'") &&
            imagekitRoutes.includes('maxBytes: MAX_TEST_UPLOAD_SIZE_BYTES') &&
            imagekitRoutes.includes("tooLargeMessage: 'File exceeds the temporary 5MB limit'"),
        'a route lost its limit or its message'
    );
    check(
        'the 8MB limit is defined once and imported where it is used',
        (policySource.match(/MAX_MEDIA_UPLOAD_SIZE_BYTES = /g) ?? []).length === 1 &&
            !/MAX_MEDIA_UPLOAD_SIZE_BYTES = /.test(mediaRoutes) &&
            !/MAX_MEDIA_UPLOAD_SIZE_BYTES = /.test(mediaController) &&
            mediaController.includes('from \'./image-upload-policy\'') &&
            mediaRoutes.includes('from \'./image-upload-policy\''),
        'the limit is declared in more than one place'
    );
    check(
        'the unverified ImageKit checks clause is absent by decision (P1.2a)',
        !/checks\s*:/.test(imagekitService) && !/buildUploadChecks/.test(imagekitService),
        'an ImageKit checks clause is present — its syntax is unverified against the live API and its failure mode is every upload 400ing'
    );
    check(
        'no secret or credential is embedded alongside the upload policy',
        !/IMAGEKIT_PRIVATE_KEY\s*=\s*'/.test(policySource),
        'the policy module contains a literal secret'
    );

    /* ── Result ────────────────────────────────────────────────────────── */
    console.log('\n=== Result ===');

    if (failures.length > 0) {
        console.log(`FAILED (${failures.length}):`);
        for (const failure of failures) {
            console.log(`  - ${failure}`);
        }

        // exitCode rather than process.exit(): tearing the process down while
        // fetch handles are still closing trips a libuv assertion on Windows.
        process.exitCode = 1;
        return;
    }

    console.log('All file upload checks passed.');
};

void main();
