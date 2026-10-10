/**
 * Seed script — populates the Brand collection with the storefront's existing brands.
 *
 * Usage:  npm run seed:brands
 *
 * The names below mirror `mioralane-frontend/src/constants/site.ts` → `BRANDS`,
 * which the storefront renders today (`brands-marquee.tsx` and the navbar's brand
 * dropdown read that constant). This script is what the admin-managed version
 * replaces it with, so the list and the order are copied rather than invented.
 *
 * ## Why the seed writes no `logoUrl`
 *
 * It used to. Six brands were mapped to their exact file names in
 * `mioralane-frontend/public/brands` (spelled out per brand, because `slugify()`
 * lower-cases while the files are `COSRX.svg`, `Beauty-of-Joseon.svg` and so on —
 * a `/brands/cosrx.svg` path resolves on Windows and 404s on Linux), and the seed
 * wrote that path into `logoUrl`.
 *
 * That was wrong in kind, not just in detail: it made the **storefront repository
 * the source of truth for brand artwork**. A logo is an uploaded asset — an admin
 * picks a file, `POST /api/media/images` stores it, and `logoUrl` points at the
 * CDN. Bundling artwork in the app repo means adding a logo needs a frontend
 * deploy, and re-running this seed would silently revert every uploaded logo back
 * to a path in that repo.
 *
 * So the seed sets `name`, `slug`, `order` and the visibility flags, and leaves
 * `logoUrl` and `logoAlt` unset. Upload the logo in the admin panel.
 *
 * ## Why no logoWidth / logoHeight
 *
 * Those fields reserve a box so an uploaded raster cannot shift the layout as it
 * loads. The storefront sizes brand logos from CSS instead, so they are left out
 * deliberately — see the same note on the admin's brand payload type.
 *
 * ## Artwork always takes the guarded path
 *
 * `sanitizeSvgContent()` runs on upload, and uploading is now the only way a logo
 * enters the collection. Nothing here bypasses it.
 */

import "../env"; // load .env
import mongoose from "mongoose";
import { connectDB } from "../data-source";
import { Brand } from "../brand/brand.model";
import { slugify } from "../utils/slugify";

/** Mirrors `mioralane-frontend/src/constants/site.ts` → `BRANDS`. Index is the display order. */
const BRAND_NAMES = [
    "3W Clinic",
    "AESTURA",
    "APLB",
    "APRILSKIN",
    "Abib",
    "Acwell",
    "Anua",
    "Aromatica",
    "Axis-Y",
    "BAREN",
    "BELIF",
    "BEPLAIN",
    "BIODANCE",
    "Banila CO",
    "Beauty of Joseon",
    "Benton",
    "Bonajour",
    "COSRX",
    "Celimax",
    "I'm From",
    "Illiyoon",
    "JIGOTT",
    "Mediheal",
    "Mise en Scene",
    "Nature Republic",
    "NEOGEN",
    "Numbuzin",
    "Purito",
    "Round Lab",
    "SKIN1004",
    "Some By Mi",
    "Torriden",
    "VT Cosmetics",
];

/**
 * Brands that are expected to carry artwork, and so are pre-flagged for the
 * homepage marquee.
 *
 * This was a map to file names in `mioralane-frontend/public/brands`; the names
 * are all that is left of it (see the header). The flag records the *intent* to
 * show a brand in the marquee, preserved so that uploading a logo is all it takes
 * for these to appear — `listMarqueeBrands()` still requires a logo, so a flagged
 * brand without artwork stays out.
 */
const MARQUEE_NAMES: ReadonlySet<string> = new Set([
    "COSRX",
    "Beauty of Joseon",
    "Anua",
    "Purito",
    "SKIN1004",
    "Axis-Y",
]);

async function seed() {
    console.log("⏳ Connecting to MongoDB...");
    await connectDB();

    let created = 0;
    let skipped = 0;

    // Skipped by NAME, not by slug: a brand whose slug was edited in the admin
    // panel still exists, and re-running the seed must not create a second row.
    for (const [index, name] of BRAND_NAMES.entries()) {
        const existing = await Brand.findOne({ name });

        if (existing) {
            console.log(`⏭  Skipping "${name}" — already exists`);
            skipped += 1;
            continue;
        }

        const brand = await Brand.create({
            name,
            slug: slugify(name),
            order: index,
            // No `logoUrl` and no `logoAlt`: artwork is uploaded through the admin,
            // and pointing at a path in the storefront repo is how a logo ends up
            // 404ing on a deploy. See the header.
            showInNavbar: true,
            // Pre-flagged so that uploading a logo is all it takes for these to
            // appear. `listMarqueeBrands()` also requires a logo, so an artwork-less
            // brand stays out either way.
            showInMarquee: MARQUEE_NAMES.has(name),
            visible: true,
        });

        created += 1;
        console.log(`✅ Created "${brand.name}" (slug: ${brand.slug})`);
    }

    const total = await Brand.countDocuments();
    console.log(`\n📦 Brands in DB: ${total} (created ${created}, skipped ${skipped})`);

    await mongoose.disconnect();
    process.exit(0);
}

seed().catch(async (err) => {
    console.error("❌ Seed failed:", err);
    await mongoose.disconnect();
    process.exit(1);
});
