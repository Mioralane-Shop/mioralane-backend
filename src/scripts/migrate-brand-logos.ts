/**
 * One-time migration: move the bundled brand logos into ImageKit.
 *
 * Six brands were seeded with a logo URL that pointed at a file committed to the
 * storefront repository (`/brands/COSRX.svg`). That made the frontend repo the source of
 * truth for brand artwork: adding a logo meant a frontend deploy, and re-running
 * `seed:brands` would have reverted any uploaded logo back to a repo path. `seed-brands`
 * stopped writing those paths; this script moves the rows that already have one.
 *
 * ## Behaviour
 *
 *   - Only rows whose `logoUrl` starts with `/brands/` are considered. Everything else is
 *     reported and left alone, so the run is safe on a database that has already been
 *     migrated or that has logos uploaded through the admin.
 *   - Idempotent: a `logoUrl` that is already an absolute `http(s)` URL is skipped.
 *   - VALIDATE FIRST, UPLOAD SECOND. All candidate files are read, sniffed and (for SVG)
 *     sanitised before the first upload. If any one of them is unreadable or unsupported,
 *     the script changes nothing and says so — a half-migrated brand list is worse than an
 *     unmigrated one, and the failure would otherwise only show up as one broken logo.
 *   - The upload goes through the same `ImageKitService` the HTTP route uses, with
 *     `assetType: 'brand-logo'`, so the destination folder, filename prefix and extension
 *     rules are identical to an admin upload.
 *
 * ## Deviations from the admin upload path, deliberately
 *
 * This script calls the service directly rather than posting to `/api/media/images`. It
 * therefore repeats the two checks that controller performs and that a script would
 * otherwise skip — `detectBrandLogoMimeType` on the bytes and `sanitizeSvgContent` for
 * SVG. A brand logo may be an SVG, so skipping the sanitiser here would put
 * unsanitised markup into the CDN through the back door.
 *
 * ## What it does NOT do
 *
 * `logoWidth` / `logoHeight` are left untouched. ImageKit returns dimensions on upload, so
 * they could be recorded here, but it is a deliberate omission: nothing reads those fields
 * today — every logo surface sizes the image in CSS — so populating them would be a change
 * with its own verification, not a side effect of a URL migration.
 *
 * Usage:
 *   npm run migrate:brand-logos
 */

import '../env';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { connectDB } from '../data-source';
import Brand from '../brand/brand.model';
import { MEDIA_FOLDER_BY_TYPE, ImageKitService } from '../imagekit/imagekit.service';
import {
    SVG_SANITIZE_REJECTION_MESSAGE,
    detectBrandLogoMimeType,
    sanitizeSvgContent,
    type BrandLogoMimeType,
} from '../media/image-upload-policy';

/** The repo-relative prefix that identifies a logo living in the frontend. */
const LEGACY_LOGO_PREFIX = '/brands/';

/**
 * Where a legacy logo's file used to live, resolved from THIS FILE rather than
 * `process.cwd()`: `npm run` sets the cwd to the backend root, but `npx tsx
 * src/scripts/...` from elsewhere would look in the wrong directory and report
 * "file not found" — which reads like a data problem instead of a path bug.
 *
 * The candidates come from the database, never from this directory: each filename
 * is derived from a legacy `logoUrl` value. Nothing enumerates the directory, so
 * an absent one only matters if the database still holds a legacy path.
 */
const FRONTEND_BRANDS_DIR = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'mioralane-frontend',
    'public',
    'brands'
);

/** Already migrated (or uploaded through the admin). */
const isRemoteUrl = (value: unknown): boolean =>
    typeof value === 'string' && /^https?:\/\//i.test(value.trim());

const isLegacyPath = (value: unknown): boolean =>
    typeof value === 'string' && value.trim().startsWith(LEGACY_LOGO_PREFIX);

type Prepared = {
    id: string;
    name: string;
    before: string;
    fileName: string;
    buffer: Buffer;
    mimeType: BrandLogoMimeType;
};

type Change = {
    name: string;
    before: string;
    after: string;
    detail?: string;
};

const log = (label: string, change: Change): void => {
    console.log(`   ${label.padEnd(10)} ${change.name}`);
    console.log(`                before: ${change.before}`);
    console.log(`                after : ${change.after}`);
    if (change.detail) {
        console.log(`                detail: ${change.detail}`);
    }
};

async function migrateBrandLogos(): Promise<void> {
    console.log('⏳ Connecting to MongoDB...');
    await connectDB();

    const brands = await Brand.find({}).sort({ order: 1, name: 1 });
    console.log(`🏷️  Brands in the collection: ${brands.length}\n`);

    const candidates = brands.filter((brand) => isLegacyPath(brand.logoUrl));
    const alreadyRemote = brands.filter((brand) => isRemoteUrl(brand.logoUrl));
    const withoutLogo = brands.filter((brand) => !brand.logoUrl || !String(brand.logoUrl).trim());

    console.log(`📦 Legacy "/brands/…" rows to migrate: ${candidates.length}`);
    console.log(`☁️  Already absolute URLs (skipped):   ${alreadyRemote.length}`);
    console.log(`➖  No logo at all (skipped):          ${withoutLogo.length}\n`);

    if (candidates.length === 0) {
        console.log('✅ Nothing to do — every logo is either absolute or absent.');
        return;
    }

    /* ── Phase 1: validate everything before touching the network ───────────── */

    console.log(`🔎 Validating ${candidates.length} file(s) in ${FRONTEND_BRANDS_DIR}`);
    const prepared: Prepared[] = [];
    const blocked: Change[] = [];

    for (const brand of candidates) {
        const before = String(brand.logoUrl);
        const fileName = before.slice(LEGACY_LOGO_PREFIX.length);
        const absolutePath = path.join(FRONTEND_BRANDS_DIR, fileName);
        const failure = (detail: string): void => {
            blocked.push({ name: brand.name, before, after: '(unchanged)', detail });
            log('BLOCKED', { name: brand.name, before, after: '(unchanged)', detail });
        };

        let buffer: Buffer;
        try {
            buffer = await readFile(absolutePath);
        } catch (error) {
            failure(`cannot read ${absolutePath} — ${(error as Error).message}`);
            continue;
        }

        if (buffer.length === 0) {
            failure(`${absolutePath} is empty`);
            continue;
        }

        // Sniffed from the bytes, never inferred from the `.svg` extension.
        const mimeType = detectBrandLogoMimeType(buffer);
        if (!mimeType) {
            failure(`${fileName} is not a recognised image (no MIME signature matched)`);
            continue;
        }

        if (mimeType === 'image/svg+xml' && !sanitizeSvgContent(buffer)) {
            failure(`${SVG_SANITIZE_REJECTION_MESSAGE} (${fileName})`);
            continue;
        }

        prepared.push({ id: brand._id.toString(), name: brand.name, before, fileName, buffer, mimeType });
        log('READY', { name: brand.name, before, after: '(pending upload)', detail: `${mimeType}, ${buffer.length} bytes` });
    }

    if (blocked.length > 0) {
        console.error(
            `\n❌ ${blocked.length} file(s) could not be validated, so NOTHING was uploaded and no brand was changed.`
        );
        console.error('   Fix the file(s) above and re-run. A partial migration is harder to unwind than none.');
        process.exitCode = 1;
        return;
    }

    /* ── Phase 2: upload, then update the row ──────────────────────────────── */

    console.log(
        `\n⬆️  Uploading ${prepared.length} logo(s) to ${MEDIA_FOLDER_BY_TYPE['brand-logo']} via ImageKit...`
    );
    const service = new ImageKitService();
    const changed: Change[] = [];
    const failed: Change[] = [];

    for (const item of prepared) {
        try {
            const uploaded = await service.uploadMediaImage(
                {
                    buffer: item.buffer,
                    originalname: item.fileName,
                    mimetype: item.mimeType,
                    size: item.buffer.length,
                },
                item.mimeType,
                'brand-logo'
            );

            const url = typeof uploaded.url === 'string' && uploaded.url.trim() ? uploaded.url.trim() : null;
            if (!url) {
                throw new Error('ImageKit returned no url');
            }

            await Brand.updateOne({ _id: item.id }, { $set: { logoUrl: url } });
            const change = { name: item.name, before: item.before, after: url };
            changed.push(change);
            log('MIGRATED', change);
        } catch (error) {
            const change = {
                name: item.name,
                before: item.before,
                after: '(unchanged)',
                detail: (error as Error).message,
            };
            failed.push(change);
            log('FAILED', change);
        }
    }

    /* ── Report ────────────────────────────────────────────────────────────── */

    console.log('\n=== Result ===');
    console.log(`  migrated        : ${changed.length}`);
    console.log(`  failed          : ${failed.length}`);
    console.log(`  skipped (remote): ${alreadyRemote.length}`);
    console.log(`  skipped (none)  : ${withoutLogo.length}`);

    if (failed.length > 0) {
        console.error('\n❌ Some brands were not migrated — see FAILED above.');
        process.exitCode = 1;
        return;
    }

    console.log('\n✅ Every legacy "/brands/…" logo now points at ImageKit.');
}

migrateBrandLogos()
    .catch((error) => {
        console.error('\n❌ Migration failed:', error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect().catch(() => undefined);
    });
