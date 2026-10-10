/**
 * P1.4 Block A — stored URL safety (decisions ①②). Block D added the eighth field.
 *
 * Run with: npm run verify:url-safety
 *
 * ## The hole this closes
 *
 * Eight fields across five schemas accept a string an admin types and a client
 * later binds to an `href` or an `<img src>`. The only constraint on all of them
 * was "is a string", so a stored `javascript:…` became script execution on the
 * storefront with nothing in between — the storefront wrote both the campaign CTA
 * and the announcement URL straight into `href`, and the campaign poster straight
 * into `<Image src>`.
 *
 * ## What is asserted
 *
 *   1. `safeUrlSchema()` itself, table-driven over refused and accepted values,
 *   2. every guarded field of every real schema, reached by walking `.shape`, so a
 *      field cannot fall out of a schema and still pass,
 *   3. end-to-end `.safeParse` of a realistic payload per schema — each with a
 *      passing baseline first, because a baseline is what makes a rejection
 *      attributable to the URL rather than to an unrelated bad field, and each
 *      asserting *which* issue path fired,
 *   4. the source, so an unguarded `z.string()` cannot creep back into a site.
 *
 * ## Negative controls
 *
 * §D builds twins of two real schemas that differ only in the guard, and shows a
 * bare `z.string().trim()` accepts exactly the values §A refuses. If the
 * refinement were dropped, those twins are what the real schemas would behave
 * like — which is the regression this harness has to catch.
 *
 * Exits non-zero if any check fails.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SAFE_URL_MESSAGE, safeUrlSchema } from '../src/utils/validation';
import { createProductSchema } from '../src/product/product.schemas';
import { createComboSchema } from '../src/combo/combo.schemas';
import { CAMPAIGN_TYPES, createCampaignSchema } from '../src/promotion/promotion.schemas';
import { announcementSettingsSchema } from '../src/announcement/announcement.schemas';
import { mediaAssetSchema } from '../src/media/media-upload.schemas';

const SRC_DIR = join(__dirname, '..', 'src');
const VALIDATION_FILE = join(SRC_DIR, 'utils', 'validation.ts');
const ANNOUNCEMENT_SCHEMAS_FILE = join(SRC_DIR, 'announcement', 'announcement.schemas.ts');

/** One guarded field per entry, with the count of guard call-sites expected in that file. */
const SCHEMA_FILE_EXPECTATIONS: { label: string; file: string; guarded: number }[] = [
    { label: 'product.schemas.ts', file: join(SRC_DIR, 'product', 'product.schemas.ts'), guarded: 2 },
    { label: 'combo.schemas.ts', file: join(SRC_DIR, 'combo', 'combo.schemas.ts'), guarded: 2 },
    {
        label: 'promotion.schemas.ts',
        file: join(SRC_DIR, 'promotion', 'promotion.schemas.ts'),
        guarded: 2,
    },
    {
        label: 'announcement.schemas.ts',
        file: ANNOUNCEMENT_SCHEMAS_FILE,
        guarded: 1,
    },
    { label: 'media-upload.schemas.ts', file: join(SRC_DIR, 'media', 'media-upload.schemas.ts'), guarded: 1 },
];

const JAVASCRIPT_URL = 'javascript:alert(1)';

/**
 * Values the allowlist must refuse, with the reason each one is in the table.
 *
 * The reason is only printed when a check fails, so it doubles as the explanation
 * for whoever breaks it.
 */
const REJECTED_VALUES: { value: string; why: string }[] = [
    { value: JAVASCRIPT_URL, why: 'the scheme this block exists for' },
    { value: 'JaVaScRiPt:alert(1)', why: 'mixed case must not slip past a prefix test' },
    { value: '   javascript:alert(1)', why: 'leading whitespace, tested after trim()' },
    { value: 'javascript:alert(document.domain)', why: 'reads the real origin' },
    { value: 'javascript:void(0)', why: 'harmless-looking, still a scheme' },
    {
        value: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
        why: 'base64-encoded HTML document',
    },
    { value: 'data:text/html,<script>alert(1)</script>', why: 'inline HTML document' },
    { value: 'vbscript:msgbox(1)', why: 'legacy script scheme' },
    { value: '//evil.example/x', why: 'protocol-relative — inherits the page scheme' },
    { value: '///evil.example/x', why: 'three slashes, still not a path' },
    { value: '//', why: 'a bare protocol-relative prefix' },
    {
        value: '/\\evil.example/x',
        why: 'backslash: browsers normalise it to a second slash',
    },
    { value: 'evil.example/x', why: 'neither absolute nor site-relative' },
    { value: 'http://mioralane.com/shop', why: 'plain http is refused by the agreed rule' },
    { value: 'ftp://evil.example/x', why: 'not an allowed scheme' },
    { value: 'mailto:hi@example.com', why: 'not a navigation target for these fields' },
    {
        value: 'HTTPS://mioralane.com/shop',
        why: 'case-sensitive comparison — known, deliberate trade-off',
    },
];

const ACCEPTED_VALUES: { value: string; why: string }[] = [
    { value: 'https://mioralane.com/shop', why: 'canonical absolute URL' },
    {
        value: 'https://ik.imagekit.io/mioralane/tr:w-800/product.webp',
        why: 'the ImageKit transform URLs actually stored',
    },
    { value: '/shop', why: 'site-relative path' },
    { value: '/', why: 'the site root' },
    { value: '/x//y', why: 'a double slash AFTER position 1 is an ordinary path' },
    { value: '/product/rosehip-oil?ref=popup#buy', why: 'path with query and fragment' },
    { value: '', why: 'cleared field — the documented deviation' },
    { value: '   ', why: 'whitespace only, trims to the empty string' },
];

interface ParseIssue {
    path: PropertyKey[];
    message: string;
}

/** The only slice of a Zod schema this harness reads: parse, then inspect issues. */
interface ParseableField {
    safeParse: (value: unknown) => { success: boolean; error?: { issues: ParseIssue[] } };
}

/**
 * Narrows any Zod schema to {@link ParseableField}.
 *
 * `safeParse`'s result is a discriminated union generic over the error type, and
 * spelling that out for seven differently-shaped schemas buys nothing: the members
 * read here are structurally identical. One documented cast at the boundary beats
 * seven signatures that all say the same thing.
 */
const asField = (schema: unknown): ParseableField => schema as unknown as ParseableField;

/** The message reported for `path`, or `undefined` when that path did not fail. */
const messageFor = (result: unknown, path: PropertyKey[]): string | undefined => {
    const parsed = result as { success: boolean; error?: { issues: ParseIssue[] } };

    if (parsed.success || !parsed.error) {
        return undefined;
    }

    const key = path.join('.');

    return parsed.error.issues.find((issue) => issue.path.join('.') === key)?.message;
};

/** Failure detail for a baseline assertion, so a bad fixture is diagnosable. */
const describe = (result: unknown): string => {
    const parsed = result as { success: boolean; error?: { issues: ParseIssue[] } };

    return parsed.success || !parsed.error ? 'parsed' : JSON.stringify(parsed.error.issues);
};

const main = (): void => {
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

    /**
     * Raw source, comments included.
     *
     * The documented-rationale checks below are asserted against this, never
     * against `readSource`: their point is that a note EXISTS, and stripping
     * comments first would make them unfailable instead of failing.
     */
    const readRaw = (file: string): string => readFileSync(file, 'utf8');

    // ---------------------------------------------------------------------
    section('A. The helper');
    // ---------------------------------------------------------------------

    const helper = safeUrlSchema();

    for (const { value, why } of REJECTED_VALUES) {
        check(`refuses ${JSON.stringify(value)}`, !helper.safeParse(value).success, why);
    }

    for (const { value, why } of ACCEPTED_VALUES) {
        check(`accepts ${JSON.stringify(value)}`, helper.safeParse(value).success, why);
    }

    const refusal = asField(helper).safeParse(JAVASCRIPT_URL);
    check(
        'the refusal carries the agreed message',
        refusal.error?.issues[0]?.message === SAFE_URL_MESSAGE,
        `message was ${JSON.stringify(refusal.error?.issues[0]?.message)}`
    );

    check(
        'non-string input is refused, not coerced',
        !helper.safeParse(123).success && !helper.safeParse(null).success,
        'a number or null must not reach the store'
    );

    check(
        'undefined is refused by the helper itself',
        !helper.safeParse(undefined).success,
        'optionality is the field wrapper\'s job, not the helper\'s'
    );

    check(
        'safeUrlSchema().optional() accepts undefined',
        safeUrlSchema().optional().safeParse(undefined).success
    );

    const trimmed = safeUrlSchema().safeParse('  /shop  ');
    check(
        'the parsed value is the trimmed string',
        trimmed.success && trimmed.data === '/shop',
        'trim() runs before the check, so whitespace cannot smuggle a scheme'
    );

    // ---------------------------------------------------------------------
    section('B. Every guarded field, reached through the real schemas');
    // ---------------------------------------------------------------------

    const guardedFields: { label: string; field: ParseableField }[] = [
        { label: 'product.images[]', field: asField(createProductSchema.shape.images.unwrap().element) },
        { label: 'product.hoverImage', field: asField(createProductSchema.shape.hoverImage.unwrap()) },
        { label: 'combo.images[]', field: asField(createComboSchema.shape.images.unwrap().element) },
        { label: 'combo.hoverImage', field: asField(createComboSchema.shape.hoverImage.unwrap()) },
        {
            label: 'campaign.popup.ctaUrl',
            field: asField(createCampaignSchema.shape.popup.unwrap().shape.ctaUrl.unwrap()),
        },
        {
            label: 'campaign.popup.posterUrl',
            field: asField(createCampaignSchema.shape.popup.unwrap().shape.posterUrl.unwrap()),
        },
        {
            label: 'announcement.messages[].url',
            field: asField(announcementSettingsSchema.shape.messages.unwrap().element.shape.url.unwrap()),
        },
        { label: 'mediaAsset.url', field: asField(mediaAssetSchema.shape.url.unwrap()) },
    ];

    check(
        'all eight guarded fields are reachable in the real schemas',
        guardedFields.length === 8,
        `found ${guardedFields.length}`
    );

    for (const { label, field } of guardedFields) {
        check(`${label} refuses javascript:`, !field.safeParse(JAVASCRIPT_URL).success);
        check(
            `${label} refuses a protocol-relative //evil.example`,
            !field.safeParse('//evil.example/x').success
        );
        check(
            `${label} accepts an https URL`,
            field.safeParse('https://ik.imagekit.io/mioralane/tr:w-800/a.webp').success
        );
        check(`${label} accepts a site-relative path`, field.safeParse('/shop').success);
        check(
            `${label} accepts the empty string, so clearing a field is not a validation error`,
            field.safeParse('').success
        );
    }

    // ---------------------------------------------------------------------
    section('C. End-to-end: a real payload per schema');
    // ---------------------------------------------------------------------

    const productPayload = {
        title: 'Rosehip Oil',
        shortName: 'Rosehip Oil',
        brand: 'Mioralane',
        category: 'Skincare',
        description: 'Cold-pressed rosehip oil.',
        ingredients: 'Rosa Canina Fruit Oil',
        howToUse: 'Apply two drops to clean skin.',
        price: 1200,
        stock: 10,
        volume: '30ml',
        skinType: ['Dry'],
        skinConcern: ['Dryness'],
    };
    const productBaseline = createProductSchema.safeParse(productPayload);
    check('baseline product payload parses', productBaseline.success, describe(productBaseline));

    const productImages = createProductSchema.safeParse({
        ...productPayload,
        images: ['https://ik.imagekit.io/mioralane/a.webp', JAVASCRIPT_URL],
    });
    check('product payload with a javascript: image is refused', !productImages.success);
    check(
        'and the issue is blamed on images[1] with the agreed message',
        messageFor(productImages, ['images', 1]) === SAFE_URL_MESSAGE,
        `issue path was ${JSON.stringify(messageFor(productImages, ['images', 1]))}`
    );

    const productHover = createProductSchema.safeParse({
        ...productPayload,
        hoverImage: JAVASCRIPT_URL,
    });
    check('product payload with a javascript: hoverImage is refused', !productHover.success);
    check(
        'and the issue is blamed on hoverImage',
        messageFor(productHover, ['hoverImage']) === SAFE_URL_MESSAGE
    );

    const productStorefrontShapes = createProductSchema.safeParse({
        ...productPayload,
        images: ['https://ik.imagekit.io/mioralane/tr:w-800/a.webp'],
        hoverImage: '/products/a-hover.webp',
    });
    check(
        'the shapes the storefront actually stores still parse',
        productStorefrontShapes.success,
        describe(productStorefrontShapes)
    );

    const comboPayload = { title: 'Glow Combo', price: 2400 };
    const comboBaseline = createComboSchema.safeParse(comboPayload);
    check('baseline combo payload parses', comboBaseline.success, describe(comboBaseline));

    const comboImages = createComboSchema.safeParse({
        ...comboPayload,
        images: [JAVASCRIPT_URL],
    });
    check('combo payload with a javascript: image is refused', !comboImages.success);
    check('and the issue is blamed on images[0]', messageFor(comboImages, ['images', 0]) === SAFE_URL_MESSAGE);

    const comboHover = createComboSchema.safeParse({ ...comboPayload, hoverImage: JAVASCRIPT_URL });
    check('combo payload with a javascript: hoverImage is refused', !comboHover.success);
    check('and the issue is blamed on hoverImage', messageFor(comboHover, ['hoverImage']) === SAFE_URL_MESSAGE);

    const campaignPayload = {
        name: 'Eid popup',
        campaignType: CAMPAIGN_TYPES[0],
        schedule: {
            startDate: '2026-01-01T00:00:00.000Z',
            endDate: '2026-01-31T00:00:00.000Z',
        },
    };
    const campaignBaseline = createCampaignSchema.safeParse(campaignPayload);
    check('baseline campaign payload parses', campaignBaseline.success, describe(campaignBaseline));

    const campaignCta = createCampaignSchema.safeParse({
        ...campaignPayload,
        popup: { enabled: true, ctaLabel: 'Shop now', ctaUrl: JAVASCRIPT_URL },
    });
    check('campaign popup with a javascript: ctaUrl is refused', !campaignCta.success);
    check('and the issue is blamed on popup.ctaUrl', messageFor(campaignCta, ['popup', 'ctaUrl']) === SAFE_URL_MESSAGE);

    const campaignOk = createCampaignSchema.safeParse({
        ...campaignPayload,
        popup: { enabled: true, ctaLabel: 'Shop now', ctaUrl: '/shop' },
    });
    check('a campaign popup pointing at a site-relative CTA parses', campaignOk.success, describe(campaignOk));

    const campaignPoster = createCampaignSchema.safeParse({
        ...campaignPayload,
        popup: { enabled: true, posterUrl: JAVASCRIPT_URL },
    });
    check('campaign popup with a javascript: posterUrl is refused', !campaignPoster.success);
    check(
        'and the issue is blamed on popup.posterUrl',
        messageFor(campaignPoster, ['popup', 'posterUrl']) === SAFE_URL_MESSAGE,
        `issue path was ${JSON.stringify(messageFor(campaignPoster, ['popup', 'posterUrl']))}`
    );

    const campaignPosterOk = createCampaignSchema.safeParse({
        ...campaignPayload,
        popup: { enabled: true, posterUrl: 'https://ik.imagekit.io/mioralane/tr:w-800/poster.webp' },
    });
    check(
        'the ImageKit poster URL the admin form actually uploads still parses',
        campaignPosterOk.success,
        describe(campaignPosterOk)
    );

    const announcementPayload = {
        enabled: true,
        messages: [{ text: 'Free delivery over 2000 BDT', url: '/shop' }],
    };
    const announcementBaseline = announcementSettingsSchema.safeParse(announcementPayload);
    check('baseline announcement payload parses', announcementBaseline.success, describe(announcementBaseline));

    const announcementUrl = announcementSettingsSchema.safeParse({
        enabled: true,
        messages: [{ text: 'Free delivery over 2000 BDT', url: JAVASCRIPT_URL }],
    });
    check('announcement bar with a javascript: url is refused', !announcementUrl.success);
    check(
        'and the issue is blamed on messages[0].url',
        messageFor(announcementUrl, ['messages', 0, 'url']) === SAFE_URL_MESSAGE
    );

    const mediaPayload = {
        provider: 'imagekit' as const,
        fileId: 'abc123',
        url: 'https://ik.imagekit.io/mioralane/tr:w-800/a.webp',
        name: 'a.webp',
        width: 800,
        height: 600,
    };
    const mediaBaseline = mediaAssetSchema.safeParse(mediaPayload);
    check('baseline media asset parses', mediaBaseline.success, describe(mediaBaseline));

    const mediaUrl = mediaAssetSchema.safeParse({ ...mediaPayload, url: JAVASCRIPT_URL });
    check('media asset with a javascript: url is refused', !mediaUrl.success);
    check(
        'and the issue is blamed on url',
        messageFor(mediaUrl, ['url']) === SAFE_URL_MESSAGE,
        `issue path was ${JSON.stringify(messageFor(mediaUrl, ['url']))}`
    );

    const mediaEmptyUrl = mediaAssetSchema.safeParse({ provider: 'imagekit' as const, url: '' });
    check(
        'a media asset with an empty url still parses, as before this block',
        mediaEmptyUrl.success,
        describe(mediaEmptyUrl)
    );

    // ---------------------------------------------------------------------
    section('D. Negative controls: the refinement is what refuses');
    // ---------------------------------------------------------------------

    const twin = z.string().trim();
    check(
        'a bare z.string().trim() — the old shape of all seven fields — ACCEPTS javascript:',
        twin.safeParse(JAVASCRIPT_URL).success,
        'if this failed, §A would be measuring something other than the refinement'
    );
    check(
        'a bare z.string().trim() ACCEPTS a protocol-relative //evil.example',
        twin.safeParse('//evil.example/x').success
    );

    const productTwin = createProductSchema.extend({ hoverImage: z.string().optional() });
    check(
        'a product twin differing only in the guard accepts the javascript: payload',
        productTwin.safeParse({ ...productPayload, hoverImage: JAVASCRIPT_URL }).success
    );
    check(
        'the real product schema refuses that same payload',
        !createProductSchema.safeParse({ ...productPayload, hoverImage: JAVASCRIPT_URL }).success
    );

    const mediaTwin = mediaAssetSchema.extend({ url: z.string().optional() });
    check(
        'a media-asset twin differing only in the guard accepts a javascript: url',
        mediaTwin.safeParse({ url: JAVASCRIPT_URL }).success
    );
    check(
        'the real media-asset schema refuses it',
        !mediaAssetSchema.safeParse({ url: JAVASCRIPT_URL }).success
    );

    // Block D: `posterUrl` was this exact shape until it was guarded, which is what
    // the campaign poster case in §C would have accepted. The twin is the evidence
    // that the guard, and not something else, is what refuses it now.
    const posterTwin = z.string().trim().optional();
    check(
        'a bare z.string().trim().optional() — the old posterUrl shape — ACCEPTS javascript:',
        posterTwin.safeParse(JAVASCRIPT_URL).success,
        'if this failed, the poster guard would be measuring nothing'
    );
    check(
        'and the real campaign schema now refuses the same value at popup.posterUrl',
        !createCampaignSchema.safeParse({
            ...campaignPayload,
            popup: { enabled: true, posterUrl: JAVASCRIPT_URL },
        }).success
    );

    // ---------------------------------------------------------------------
    section('E. Source: the guard cannot silently leave a site');
    // ---------------------------------------------------------------------

    for (const { label, file, guarded } of SCHEMA_FILE_EXPECTATIONS) {
        const source = readSource(file);
        const count = (source.match(/safeUrlSchema\(\)/g) ?? []).length;

        check(`${label} declares ${guarded} guarded field(s)`, count === guarded, `found ${count}`);
    }

    const guardedTotal = SCHEMA_FILE_EXPECTATIONS.reduce(
        (total, { file }) =>
            total + (readSource(file).match(/safeUrlSchema\(\)/g) ?? []).length,
        0
    );
    check('eight guard call-sites across the five schema files', guardedTotal === 8, `found ${guardedTotal}`);

    const allSchemaSource = SCHEMA_FILE_EXPECTATIONS.map(({ file }) => readSource(file)).join('\n');
    check(
        'no guarded site has reverted to a bare z.string()',
        !/(images: z\.array\(z\.string\(\)\)|hoverImage: z\.string\(\)|ctaUrl: z\.string\(\)|posterUrl: z\.string\(\))/.test(
            allSchemaSource
        ),
        'only these four are grepped: `url` is too common a field name to assert globally'
    );

    check(
        'the announcement url is the guarded declaration',
        /url: safeUrlSchema\(\)\.optional\(\)/.test(readSource(ANNOUNCEMENT_SCHEMAS_FILE))
    );

    const promotionSource = readSource(join(SRC_DIR, 'promotion', 'promotion.schemas.ts'));
    check(
        'posterUrl IS guarded (Block D) — it reaches <Image src> in the storefront popup',
        /posterUrl: safeUrlSchema\(\)\.optional\(\)/.test(promotionSource),
        'Block A excluded it as inert; a src is not inert once the renderer is not the only guard'
    );
    check(
        'promotion.schemas.ts has not left a bare posterFileId/postAlt URL-shaped field guarded',
        /posterFileId: z\.string\(\)\.trim\(\)\.optional\(\)/.test(promotionSource),
        'posterFileId is an opaque ImageKit id and posterAlt is alt text; neither is a URL'
    );

    const validationSource = readSource(VALIDATION_FILE);
    check('safeUrlSchema is exported from utils/validation', /export const safeUrlSchema/.test(validationSource));

    const validationRaw = readRaw(VALIDATION_FILE);
    check(
        'the helper explains why a prefix test rather than new URL()',
        /new URL\('javascript:/.test(validationRaw)
    );
    check('the helper documents the empty-string exemption', /empty string/.test(validationRaw));
    check('the helper states the case-sensitivity trade-off', /case-sensitive/.test(validationRaw));
    check(
        'the helper documents the protocol-relative refusal as a tightening of the agreed rule',
        /protocol-relative/.test(validationRaw) && /tightening/.test(validationRaw)
    );

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

    console.log('All URL safety checks passed.');
};

void main();
