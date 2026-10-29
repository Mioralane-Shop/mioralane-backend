# Mioralane Backend

Backend API for the **Mioralane** skincare e-commerce project.

## Tech Stack

- Node.js + TypeScript
- [Express 5](https://expressjs.com/) — the HTTP layer, assembled in `src/app.module.ts`
- MongoDB + Mongoose 9
- JWT auth (`jsonwebtoken` + `bcryptjs`), httpOnly cookie + Bearer header, Google OAuth
- Joi for environment validation, Zod for request-schema validation
- Swagger (`swagger-jsdoc` + `swagger-ui-express`) for API docs
- Deployed on an **OVH Cloud VPS** behind nginx (`https://api.mioralane.com`),
  running the compiled `dist/` output as a long-lived Node process.
  `api/index.ts` is a Vercel-compatible serverless wrapper that is kept in the
  tree but is NOT the production entrypoint.

> This section previously listed NestJS, PostgreSQL, TypeORM and
> `@nestjs/jwt` + `passport-jwt`. None of those is in use: the `src/modules/**`
> NestJS/TypeORM scaffold was dead code no entrypoint imported, and it was deleted in
> P1.7 along with the 16 dependencies behind it.

## Prerequisites

- Node.js 18+ (CI and local development run on 24)
- A MongoDB connection string in `MONGODB_URI` — no local database server is needed

## Getting Started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your environment file:

   ```bash
   cp .env.example .env
   ```

   Then fill in your MongoDB connection string, a strong `JWT_SECRET`
   (`openssl rand -base64 48`), and the three ImageKit values. `GOOGLE_CLIENT_ID`
   is only needed for Google sign-in. `.env.example` documents every variable and
   where it is read.

3. Start the development server:

   ```bash
   npm run start:dev
   ```

The API will be available at `http://localhost:5000` — the port `.env.example`
sets, and the one both front ends expect.

## Scripts

| Command                  | Description                              |
| ------------------------ | ---------------------------------------- |
| `npm run start:dev`      | Run in watch mode                        |
| `npm run start:prod`     | Run the compiled production build        |
| `npm run build`          | Compile the project into `dist/`         |
| `npm run migrate:wishlist` | Backfill `wishlist` and `comboWishlist` fields for existing users |

## Folder Structure

```
src/
├── main.ts                 # Local entry point (connects to MongoDB, then listens)
├── app.module.ts           # createApp() — the whole Express app: CORS, helmet, middleware, routers
├── data-source.ts          # Cached Mongoose connection (serverless-friendly)
│
├── middleware/             # Auth, CSRF, rate limits, validation, error handling, uploads
├── config/                 # Environment validation + typed configuration
├── enums/                  # Shared enums (order status, user role)
├── utils/                  # Shared helpers (slugify, pagination, validation)
│
├── auth/                   # Login / register / Google / session
└── <feature>/              # One folder per feature — each with .model/.schemas/.service/.controller/.routes
                          # product, combo, order, customer, address, wishlist, review, promotion,
                          # inventory, shipping, announcement, cross-sell, activity-log, dashboard,
                          # media, imagekit, instagram
api/
└── index.ts                # Vercel serverless wrapper (NOT used on OVH) — validates env, then exports createApp()
```

The cart itself is client-side: there is no server-side cart module, despite what the
original scaffold's directory list implied.

## Deploying to production (OVH Cloud VPS)

Production runs `node dist/main.js` behind nginx. **`dist/` is gitignored**, so a
`git pull` alone never changes what the running process serves — the build step is
what ships a change. Skipping it is how a merged feature can be live in the
repository while the deployed API still answers `404` for its routes.

```bash
cd /path/to/mioralane-backend

git fetch origin
git status -sb                  # confirm the branch tracks origin/production
git pull --ff-only origin production

npm ci                          # includes devDependencies: `tsc` lives there
npm run build                   # src/** -> dist/

# Prove the new modules are in the build BEFORE restarting
grep -c "api/admin/instagram" dist/app.module.js     # must be >= 1

pm2 restart mioralane-api       # or: systemctl restart mioralane-backend
```

Then verify the public surface:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://api.mioralane.com/api/instagram/feed   # 200
curl -s -o /dev/null -w "%{http_code}\n" https://api.mioralane.com/api/admin/instagram  # 401 when signed out
```

A `404` from either route means the running build predates the module — rebuild and
restart rather than changing application code. The API's own 404s are JSON
(`{"success":false,"message":"Not found"}`), which distinguishes them from an nginx
`404` with an HTML body.

`.env` is gitignored and is NOT replaced by a pull. The Instagram feed additionally
needs `INSTAGRAM_ACCESS_TOKEN` and `INSTAGRAM_ACCOUNT_ID` in the server's
`.env`; without them the routes exist but sync answers
`403 instagram_not_configured`.

## Notes

- This README is partly inherited from the original NestJS scaffold and is being
  corrected as blocks touch it. The "no business logic implemented yet" note that used
  to live here described the scaffold, not this service; the API is live. Known
  remaining staleness is tracked in `/memories/repo/mioralane-backend.md`.
- One-off scripts live in `src/scripts/`.
