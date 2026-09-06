# Mioralane Backend — Project Memory

REST API for the **Mioralane** Korean-skincare e-commerce project. Deployed on **Vercel** (serverless).

## Tech Stack
- **Node.js + TypeScript**, **Express 5** as the HTTP layer (NOT NestJS in practice — despite `package.json` still listing `@nestjs/*` deps, the app is built with `express`/`cors`/`cookie-parser` in `src/app.module.ts`).
- **MongoDB + Mongoose 9** — NOT PostgreSQL (README is out of date). `src/data-source.ts` caches the connection promise for Vercel serverless reuse.
- **JWT auth** (`jsonwebtoken` + `bcryptjs`), httpOnly cookie + Bearer header, **Google OAuth** login.
- **Joi** for env validation, **Swagger** (`swagger-jsdoc` / `swagger-ui-express`) for API docs.

## Commands
- `npm run dev` — `tsx watch src/main.ts` (hot reload)
- `npm run build` — `tsc` → `dist/`
- `npm run start` — `node dist/main.js`
- `npm run start:prod` — production run
- `npm run seed:combos` — seed combo data
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
├── middleware/        # auth.middleware (protect/adminOnly), rateLimiter.middleware (authLimiter)
├── common/  enums/  utils/  types/
├── auth/              # user.model.ts + auth.controller.ts + auth.routes.ts
├── product/  combo/  order/  customer/  dashboard/  wishlist/
└── scripts/           # seed-combos.ts, migrate-user-wishlist.ts
```

## Environment (Joi-validated)
`PORT` (default 3000), `NODE_ENV` (development|production|test), `MONGODB_URI` (required), `JWT_SECRET` (required), `JWT_EXPIRES_IN` (default `7d`). Also uses `GOOGLE_CLIENT_ID`.

## API Routes (mounted in `app.module.ts`)
| Prefix | Methods | Notes |
| --- | --- | --- |
| `/api/auth` | POST register/login/google/logout · GET me | `me` is protected; auth routes are rate-limited |
| `/api/products` | GET / · GET /:idOrSlug (public) · POST / · PUT /:id · DELETE /:id (admin) | search/sort/pagination/filters |
| `/api/combos` | GET / · GET /:idOrSlug (public) · POST / · PUT /:id · DELETE /:id (admin) | |
| `/api/orders` | POST / · GET / · GET /:id (protected user flow) | |
| `/api/admin/orders` | admin order management | |
| `/api/admin/customers` | admin customer management | |
| `/api/admin/dashboard` | GET /summary (admin) | |
| `/api/wishlist` | GET / · POST / · POST /toggle (protected) | |
| `/api` · `/api/health` | health checks | |
| `/api/docs` · `/api/docs-json` | Swagger UI + raw OpenAPI JSON | |

## Models (Mongoose)
- **User** (`auth/user.model.ts`): password auto-hashed in `pre('save')`; token payload `{ id, role: 'user'|'admin' }`.
- **Product** (`product/product.model.ts`): title, slug, brand, category, description, skinType, skinConcern, price, salePrice, badge, images, hoverImage, volume, stock, isBestSeller, isNewArrival, isTrending.
- **Combo** (`combo/combo.model.ts`): title, slug, badge, description, price, compareAtPrice, savings, includedItems, routineTag, category, brand, images, size, volume, stock, rating, numReviews, concerns, skinType, isBestSeller, isNewArrival. `toJSON` transform aliases fields for frontend `ProductCard` compatibility.
- **Order** (`order/order.model.ts`).

## Auth & Middleware
- `middleware/auth.middleware.ts` exports `protect` and `adminOnly` (use `adminOnly` *after* `protect`).
- JWT set as httpOnly cookie `token` (`secure` + `sameSite:none` in production for cross-domain) and also returned in body for Bearer flow.
- CORS allows `mioralane.com`, `www.mioralane.com`, plus localhost origins (`3000/3001/3100`).

## Critical gotchas
- **dotenv import order**: `main.ts` and `api/index.ts` must `import './env'` FIRST. ES imports are hoisted, so reading `process.env.JWT_SECRET` at module load in `auth.controller.ts` can silently fall back to an undefined/empty secret if env isn't loaded first.
- MongoDB connection middleware runs before every route handler; returns 503 if DB unavailable.
- README describes NestJS/PostgreSQL — the live code is Express/MongoDB.
