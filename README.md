# Mioralane Backend

Backend API for the **Mioralane** skincare e-commerce project.

## Tech Stack

- Node.js + TypeScript
- [Express 5](https://expressjs.com/) — the HTTP layer, assembled in `src/app.module.ts`
- MongoDB + Mongoose 9
- JWT auth (`jsonwebtoken` + `bcryptjs`), httpOnly cookie + Bearer header, Google OAuth
- Joi for environment validation, Zod for request-schema validation
- Swagger (`swagger-jsdoc` + `swagger-ui-express`) for API docs
- Deployed on Vercel via `api/index.ts`

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

   Then fill in your MongoDB connection string and a strong `JWT_SECRET`.

3. Start the development server:

   ```bash
   npm run start:dev
   ```

The API will be available at `http://localhost:3000`.

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
                          # media, imagekit
api/
└── index.ts                # The Vercel handler — validates env, then exports createApp()
```

The cart itself is client-side: there is no server-side cart module, despite what the
original scaffold's directory list implied.

## Notes

- This README is partly inherited from the original NestJS scaffold and is being
  corrected as blocks touch it. The "no business logic implemented yet" note that used
  to live here described the scaffold, not this service; the API is live. Known
  remaining staleness is tracked in `/memories/repo/mioralane-backend.md`.
- One-off scripts live in `src/scripts/`.
