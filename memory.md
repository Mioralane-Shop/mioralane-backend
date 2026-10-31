# Mioralane Backend — Project Memory

REST API for the **Mioralane** Korean-skincare e-commerce project. Deployed on an **OVH Cloud VPS** behind nginx at `https://api.mioralane.com`, running the compiled `dist/` output as a long-lived Node process (`node dist/main.js`). `api/index.ts` is a retained Vercel-style serverless wrapper and is **not** the production entrypoint.

> Deploying means `git pull` **then** `npm run build` **then** restart the process. `dist/` is gitignored, so a pull alone leaves the old build serving — that is exactly how the Instagram module sat merged in Git while production still answered `404` for `/api/admin/instagram` and `/api/instagram/feed`.

## Tech Stack
- **Node.js + TypeScript**, **Express 5** as the HTTP layer (NOT NestJS — the `@nestjs/*`/`typeorm` dependencies and the `src/modules/**` scaffold they served were **deleted in P1.7**; the app is built with `express`/`cors`/`cookie-parser` in `src/app.module.ts`).
- **MongoDB + Mongoose 9** — NOT PostgreSQL (README is out of date). `src/data-source.ts` caches the connection promise for Vercel serverless reuse.
- **JWT auth** (`jsonwebtoken` + `bcryptjs`), httpOnly cookie + Bearer header, **Google OAuth** login.
- **Joi** for env validation, **Swagger** (`swagger-jsdoc` / `swagger-ui-express`) for API docs.

## Commands
- `npm run dev` — `tsx watch src/main.ts` (hot reload)
- `npm run build` — `tsc` → `dist/`
- `npm run start` — `node dist/main.js`
- `npm run start:prod` — production run
- `npm run seed:combos` — seed combo data
- `npm run seed:admin` — provision an admin account in the `Admin` collection (prefer the bootstrap endpoint)
- `npm run verify:admin-auth` — behavioural harness for the admin 2FA/session flow (no DB needed)
- `npm run migrate:wishlist` — backfill wishlist/comboWishlist for existing users

> Run from the backend dir: `cd e:\Business\Mioralane\mioralane-backend; npm run dev`. Default port **5000** (`process.env.PORT || 5000`). Swagger at `/api/docs`.

## Structure
```
src/
├── main.ts            # entrypoint — imports './env' FIRST, then connects DB, creates app
├── app.module.ts      # buildExpress app: CORS, JSON, cookie-parser, DB middleware, Swagger, routes
├── data-source.ts     # Mongoose connectDB() with cached promise (Vercel-safe)
├── env.ts             # dotenv.config() — MUST be imported first
├── swagger.ts         # OpenAPI spec + swagger-ui
├── api/index.ts       # Vercel serverless handler
├── config/            # configuration.ts + env.validation.ts (Joi)
├── middleware/        # auth.middleware (protect = customer, adminGuard = admin), rateLimiter.middleware
├── common/  enums/  utils/  types/
├── auth/              # user.model.ts + auth.controller.ts + auth.routes.ts + jwt.constants.ts
├── admin/             # Admin/AdminOtp/AdminSession models + admin-auth controller/routes/services
├── product/  combo/  order/  customer/  dashboard/  wishlist/
└── scripts/           # seed-combos.ts, migrate-user-wishlist.ts
```

## Environment (Joi-validated)
`PORT` (default 3000), `NODE_ENV` (development|production|test), `MONGODB_URI` (required), `JWT_SECRET` (required), `JWT_EXPIRES_IN` (default `7d`). Also uses `GOOGLE_CLIENT_ID`.

Admin auth: `ADMIN_OTP_EMAIL` (inbox every OTP is sent to — the login fails closed with 503 if unset; `ADMIN_EMAIL` is the deprecated alias), `ADMIN_BOOTSTRAP_SECRET` (>=32 chars; empty disables bootstrap), `ADMIN_OTP_TTL_MINUTES` (default 5, 1-15), `ADMIN_SESSION_TTL_HOURS` (honoured outside production only; production is pinned to 3 h). See `docs/ADMIN_AUTH.md`.

## API Routes (mounted in `app.module.ts`)
| Prefix | Methods | Notes |
| --- | --- | --- |
| `/api/auth` | POST register/login/google/logout · GET me | customer only; `me` is protected; auth routes are rate-limited |
| `/api/admin/auth` | POST bootstrap/login/verify-otp/resend-otp/logout · GET me | separate admin 2FA flow; bootstrap is one-shot + secret-gated; `me`/`logout` use `adminGuard` |
| `/api/products` | GET / · GET /:idOrSlug (public) · POST / · PUT /:id · DELETE /:id (admin) | search/sort/pagination/filters |
| `/api/combos` | GET / · GET /:idOrSlug (public) · POST / · PUT /:id · DELETE /:id (admin) | |
| `/api/orders` | POST / · GET / · GET /:id (protected user flow) | |
| `/api/admin/orders` | admin order management | |
| `/api/admin/customers` | admin customer management | |
| `/api/admin/dashboard` | GET /summary (admin) | |
| `/api/wishlist` | GET / · POST / · POST /toggle (protected) | |
| `/api/hero-slides` | GET / (public — active slides only, sorted by `order`) | homepage hero slider |
| `/api/admin/hero-slides` | GET / · POST / · PATCH /reorder · PATCH /:id · DELETE /:id (admin) | `/reorder` registered BEFORE `/:id` |
| `/api` · `/api/health` | health checks | |
| `/api/docs` · `/api/docs-json` | Swagger UI + raw OpenAPI JSON | |

## Models (Mongoose)
- **User** (`auth/user.model.ts`): password auto-hashed in `pre('save')`; token payload `{ id, role: 'user'|'admin' }`.
- **Admin** (`admin/admin.model.ts`), collection `admins`: the ONLY admin account store. Normalized unique email, bcrypt password (`select: false`), `name`, `role` (`owner`|`admin`), `permissions[]`, `isActive`, `lastLoginAt`, timestamps. `role: 'admin'` on a **User** row does NOT make an admin.
- **AdminOtp** (`admin/admin-otp.model.ts`), collection `adminotps`: one outstanding login challenge — `adminId`, unique `challengeId`, SHA-256 `otpHash` (never the raw code), `expiresAt` (5 min, `ADMIN_OTP_TTL_MINUTES`), `lastSentAt` (resend cooldown), `attempts` (max 5), `consumedAt` (single use). TTL index on `expiresAt` is housekeeping only; expiry is enforced in code.
- **AdminSession** (`admin/admin-session.model.ts`), collection `adminsessions`: `adminId`, unique `tokenHash` = SHA-256 of the JWT `sid`, `expiresAt` (fixed 3 h), `revokedAt`/`revokedReason`, `lastSeenAt`. Every admin request validates this row AND the live `Admin.isActive`.
- **Product** (`product/product.model.ts`): title, slug, brand, category, description, skinType, skinConcern, price, salePrice, badge, images, hoverImage, volume, stock, isBestSeller, isNewArrival, isPopularPick. Both the model's `toJSON` and `formatProduct()` in the controller emit **`brandSlug`** (`slugify(brand)`) — the brand segment of the storefront's `/product/<brandSlug>/<slug>` URL. Keep the two aliases in step. `ingredients` (full INCI text) is **legacy**: still stored and bounded, but no longer required on create — the admin form does not send it, and an update that omits it leaves the stored value untouched. `keyIngredients` is an ordered, **name-only** `{ name }[]`, **required with at least one entry** and capped at **5** (the storefront's only ingredient display; the optional per-ingredient description was removed and is stripped from any payload that still sends one). The requirement lives in the request schema, not the model, so legacy products with none can still be saved by non-content flows such as stock changes.
- **Combo** (`combo/combo.model.ts`): title, slug, badge, description, price, compareAtPrice, savings, includedItems, routineTag, category, brand, images, size, volume, stock, rating, numReviews, concerns, skinType, isBestSeller, isNewArrival. `toJSON` transform aliases fields for frontend `ProductCard` compatibility.
- **Order** (`order/order.model.ts`).
- **HeroSlide** (`hero-slide/hero-slide.model.ts`), collection `heroslides`: `imageUrl`, `targetUrl` (both `https://` or site-relative, via `safeUrlSchema`), `altText?`, `order` (default 0; a create without one appends at `max+1`), `isActive` (default true), timestamps. Collection, not a singleton — the homepage hero poster rotation, curated from the admin's "Hero Slider" page. Public read is `{ isActive: true }` sorted `{ order, createdAt }`; index `{ isActive: 1, order: 1 }`. Audit rows use `entityType: 'HERO_SLIDE'`. Its banner is uploaded through the shared media endpoint with `assetType: 'hero-slide'` (folder `/mioralane/hero-slides`, prefix `mioralane-hero-slide`, JPEG/PNG/WebP only — SVG stays brand-logo-only).

## Auth & Middleware
- `middleware/auth.middleware.ts` exports TWO separate families:
  - customer: `protect` (reads the `token` cookie / `Authorization` header, verifies a customer JWT, loads the live `User` role).
  - admin: `adminProtect` + `adminOnly`, exposed to routes as `adminGuard` (`[...]` frozen). It reads ONLY the `admin_token` cookie, verifies an admin JWT (audience `mioralane-admin-clients`, claim `typ: 'admin'`), then requires a live unrevoked unexpired `adminsessions` row belonging to an active `Admin`.
  - `adminOnly` requires `req.admin` (set only by `adminProtect`), so pairing it with `protect` fails closed. Every `/api/admin/*` business route uses `adminGuard`.
  - `adminProtect` also sets `req.user = { id, role: 'admin' }` as an audit-field compatibility shim; that value comes from the verified admin session.
- Customer JWT is httpOnly cookie `token` (+ `Authorization: ****** fallback). Admin JWT is httpOnly cookie `admin_token` only. Both are `secure` + `sameSite:none` in production.
- Admin sessions are exactly 3 h from OTP verification and never slide. `ADMIN_SESSION_TTL_HOURS` is honoured OUTSIDE production only, so staging can shorten a session for expiry testing without touching the production policy.
- CSRF: `csrfTokenGuard` accepts a token derived from ANY session cookie present (customer scope `csrf.v1`, admin scope `csrf.admin.v1`). Pre-session admin endpoints (`bootstrap`, `login`, `verify-otp`, `resend-otp`) are exempt by exact path; `logout` is not.
- JWT set as httpOnly cookie `token` (`secure` + `sameSite:none` in production for cross-domain) and also returned in body for Bearer flow.
- CORS allows `mioralane.com`, `www.mioralane.com`, plus localhost origins (`3000/3001/3100`).

## Critical gotchas
- **dotenv import order**: `main.ts` and `api/index.ts` must `import './env'` FIRST. ES imports are hoisted, so reading `process.env.JWT_SECRET` at module load in `auth.controller.ts` can silently fall back to an undefined/empty secret if env isn't loaded first.
- MongoDB connection middleware runs before every route handler; returns 503 if DB unavailable.
- README describes NestJS/PostgreSQL — the live code is Express/MongoDB.
