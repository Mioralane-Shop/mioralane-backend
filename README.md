# Mioralane Backend

Backend API for the **Mioralane** skincare e-commerce project.

## Tech Stack

- [NestJS](https://nestjs.com/) (Node.js framework)
- TypeScript
- PostgreSQL
- TypeORM
- JWT Authentication (`@nestjs/jwt` + `passport-jwt`)

## Prerequisites

- Node.js 18+
- PostgreSQL running locally

## Getting Started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your environment file:

   ```bash
   cp .env.example .env
   ```

   Then fill in your PostgreSQL credentials and a strong `JWT_SECRET`.

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
| `npm run typeorm`        | Run the TypeORM CLI (uses `src/data-source.ts`) |

## Folder Structure

```
src/
├── main.ts                 # Application entry point (bootstrap + global ValidationPipe)
├── app.module.ts           # Root module (imports Config, TypeORM and all feature modules)
├── data-source.ts          # Standalone TypeORM DataSource (for CLI tooling)
│
├── common/                 # Shared cross-cutting concerns (guards, decorators, filters, interceptors)
├── config/                 # Environment validation + typed configuration
├── enums/                  # Shared enums (order status, user role)
├── utils/                  # Shared helpers (slugify, pagination)
│
├── auth/                   # Authentication module (JWT strategy, login/register DTOs)
└── modules/
    ├── users/              # User management
    ├── categories/         # Product categories
    ├── products/           # Products
    ├── cart/               # Shopping cart
    └── orders/             # Orders & order items
```

## Notes

- The project is intentionally a **minimal production-ready skeleton** for frontend integration.
- No business logic has been implemented yet — controllers and services contain empty boilerplate methods with `TODO` markers.
- No migrations, Docker, Redis, payments, uploads, roles/permissions, or admin APIs are configured at this stage.
- TypeORM `synchronize` is enabled in non-production environments for quick prototyping; switch to migrations for production.
