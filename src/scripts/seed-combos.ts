/**
 * Seed script — populates the Combo collection with the three default bundles.
 *
 * Usage:  npx tsx src/scripts/seed-combos.ts
 */

import "../env"; // load .env
import { connectDB } from "../data-source";
import { Combo, ICombo } from "../combo/combo.model";

const DEFAULT_COMBOS: Omit<ICombo, "slug">[] = [
    {
        title: "Glass Skin 4-Step Routine",
        badge: "MORNING ROUTINE",
        description:
            "The complete Korean glass skin routine in one bundle: Cleanser + Toner + Serum + Moisturizer + Sunscreen. Save 15% compared to buying individually.",
        price: 4250,
        compareAtPrice: 5100,
        savings: 850,
        includedItems: ["Cleanser", "Toner", "Serum", "Moisturizer", "Sunscreen"],
        routineTag: "For Glass Skin",
        category: "combo",
        brand: "Mioralane Bundle",
        images: ["/images/promo-routine.jpg"],
        size: "5-piece set",
        volume: "5-piece set",
        stock: 20,
        rating: 4.9,
        numReviews: 89,
        concerns: ["Complete Routine", "Best Value"],
        skinType: "All skin types",
        isBestSeller: true,
        isNewArrival: false,
    },
    {
        title: "Acne Fighter Bundle",
        badge: "ACNE COMBO",
        description:
            "Target acne with COSRX Low pH Cleanser + COSRX Snail Mucin + Beauty of Joseon Glow Serum. A powerful 3-step routine for breakout-prone skin.",
        price: 3200,
        compareAtPrice: 4000,
        savings: 800,
        includedItems: ["Low pH Cleanser", "Snail Mucin", "Glow Serum"],
        routineTag: "For Acne Care",
        category: "combo",
        brand: "Mioralane Bundle",
        images: ["/images/cosrx-snail.jpg"],
        size: "3-piece set",
        volume: "3-piece set",
        stock: 25,
        rating: 4.8,
        numReviews: 67,
        concerns: ["Acne", "Oil Control"],
        skinType: "Oily / Acne-prone",
        isBestSeller: true,
        isNewArrival: false,
    },
    {
        title: "Travel Essentials Kit",
        badge: "TRAVEL KIT",
        description:
            "Mini versions of our bestsellers — perfect for travel or trying before committing to full sizes.",
        price: 1850,
        compareAtPrice: 2200,
        savings: 350,
        includedItems: ["Cleanser", "Toner", "Moisturizer", "Sunscreen"],
        routineTag: "For On-the-Go",
        category: "combo",
        brand: "Mioralane Bundle",
        images: ["/images/promo-minis.jpg"],
        size: "4-piece mini set",
        volume: "4-piece mini set",
        stock: 30,
        rating: 4.7,
        numReviews: 45,
        concerns: ["Travel Size", "Try Before Buy"],
        skinType: "All skin types",
        isBestSeller: false,
        isNewArrival: true,
    },
];

async function seed() {
    console.log("⏳ Connecting to MongoDB...");
    await connectDB();

    // Upsert each combo by title so repeated runs don't duplicate
    for (const combo of DEFAULT_COMBOS) {
        const existing = await Combo.findOne({ title: combo.title });
        if (existing) {
            console.log(`⏭  Skipping "${combo.title}" — already exists`);
            continue;
        }

        const doc = await Combo.create(combo);
        console.log(`✅ Created "${doc.title}" (slug: ${doc.slug})`);
    }

    const total = await Combo.countDocuments();
    console.log(`\n📦 Combos in DB: ${total}`);

    process.exit(0);
}

seed().catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
});
