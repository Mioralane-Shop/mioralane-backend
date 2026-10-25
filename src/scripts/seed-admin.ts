/**
 * Seed script — provisions the universal primary admin account in the
 * dedicated `Admin` collection (separate from the customer `User` collection).
 *
 * Usage:  npm run seed:admin
 *
 * - Email: `mioralaneshop@gmail.com` (override with ADMIN_EMAIL).
 * - Password: read from `ADMIN_SEED_PASSWORD` (never hardcoded in source).
 *   When it is unset, a cryptographically random password is generated and
 *   printed ONCE. Either way the model's pre-save hook bcrypt-hashes it — the
 *   database only ever holds the hash, never plaintext.
 * - Idempotent: an existing account's password is never changed by a re-run.
 */

import "../env"; // load .env
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { connectDB } from "../data-source";
import { AdminModel } from "../admin/admin.model";

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? "mioralaneshop@gmail.com").trim().toLowerCase();

const seed = async (): Promise<void> => {
    await connectDB();

    const existing = await AdminModel.findOne({ email: ADMIN_EMAIL });

    if (existing) {
        console.log(
            `✅ Admin ${ADMIN_EMAIL} already exists (name: ${existing.name ?? "—"}, role: ${existing.role}) — password untouched`
        );
        await mongoose.disconnect();
        process.exit(0);
    }

    const configuredPassword = (process.env.ADMIN_SEED_PASSWORD ?? "").trim();
    const generated = configuredPassword === "";

    // 18 random bytes -> 24 url-safe characters. The plaintext is never
    // persisted anywhere except the operator's password manager.
    const password = generated ? randomBytes(18).toString("base64url") : configuredPassword;

    if (password.length < 8) {
        throw new Error("ADMIN_SEED_PASSWORD must be at least 8 characters (the model enforces this)");
    }

    const admin = await AdminModel.create({
        email: ADMIN_EMAIL,
        password,
        name: process.env.ADMIN_NAME?.trim() || undefined,
        role: "admin",
    });

    console.log(`✅ Created admin account ${admin.email} (role: ${admin.role}) — password stored bcrypt-hashed`);

    if (generated) {
        console.log("\n   ⚠️  No ADMIN_SEED_PASSWORD was set, so a random password was generated.");
        console.log("   Save it now — it is shown only this once:");
        console.log(`   ${password}\n`);
    }

    await mongoose.disconnect();
    process.exit(0);
};

seed().catch(async (err) => {
    console.error("❌ Admin seed failed:", err);
    await mongoose.disconnect();
    process.exit(1);
});
