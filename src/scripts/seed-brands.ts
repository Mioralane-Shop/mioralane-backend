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
 * ## Why the logo file names are spelled out per brand
 *
 * The obvious `logoUrl: \`/brands/${slug}.svg\`` is wrong for four of the six:
 * slugify() lower-cases, but the files on disk are `COSRX.svg`,
 * `Beauty-of-Joseon.svg`, `Purito.svg` and `AXIS-Y.svg`. `/brands/cosrx.svg`
 * resolves on Windows and **404s on every deployed Linux environment** — a
 * filesystem that is case-insensitive exactly where you are testing it. Only
 * `anua.svg` and `skin1004.svg` happen to match their slug.
 *
 * `mioralane-frontend`'s own `components/common/brands-marquee.tsx` already
 * hardcodes these same six with this exact casing, which is the authoritative
 * list. If the SVGs are ever renamed to their slugs, this map is what to delete.
 *
 * ## Why no logoWidth / logoHeight
 *
 * Those fields exist to reserve a box so a raster logo cannot shift the layout
 * when it loads. All six of these are SVG — vector, with no intrinsic pixel size
 * to record — so the storefront sizes them from CSS. They stay empty until an
 * admin replaces one with an uploaded raster, which is when the upload records
 * the dimensions the API returns.
 *
 * ## Not content-checked, deliberately
 *
 * `sanitizeSvgContent()` runs on UPLOAD only, so these six committed SVGs bypass
 * it. They are repository assets reviewed in a pull request, not client input —
 * the check exists to stop an *uploader* storing script-bearing markup. Anything
 * an admin uploads through `POST /api/media/images` takes the guarded path.
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
 * The six brands that ship with artwork, mapped to the EXACT file name in
 * `mioralane-frontend/public/brands`. See the header for why this is not derived
 * from the slug.
 */
const LOGO_FILE_BY_NAME: Readonly<Record<string, string>> = {
    COSRX: "COSRX.svg",
    "Beauty of Joseon": "Beauty-of-Joseon.svg",
    Anua: "anua.svg",
    Purito: "Purito.svg",
    SKIN1004: "skin1004.svg",
    "Axis-Y": "AXIS-Y.svg",
};

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

        const logoFile = LOGO_FILE_BY_NAME[name];

        const brand = await Brand.create({
            name,
            slug: slugify(name),
            order: index,
            // Site-relative so the storefront serves it from its own origin. Only
            // the six with artwork get one.
            logoUrl: logoFile ? `/brands/${logoFile}` : undefined,
            logoAlt: logoFile ? `${name} logo` : undefined,
            showInNavbar: true,
            // Only brands WITH a logo: the marquee renders logos, and
            // `listMarqueeBrands()` would exclude a logo-less brand anyway.
            showInMarquee: Boolean(logoFile),
            visible: true,
        });

        created += 1;
        console.log(
            `✅ Created "${brand.name}" (slug: ${brand.slug})${logoFile ? ` — logo ${logoFile}` : ""}`
        );
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
