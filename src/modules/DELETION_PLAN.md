# Deletion plan — `src/modules/**` (the dead NestJS/TypeORM layer)

**Status: NOT EXECUTED.** This file is the plan for its own block (P1.6). It is
deliberately kept separate: it is a structural change, not a dependency bump, and
it needs the before/after route-inventory control described at the bottom.

> Note for whoever runs it: this file lives *inside* the directory it describes.
> Move it to `docs/` in the same commit as the deletion (the same content is in
> `/memories/repo/mioralane-backend.md`), or the plan is deleted with the code.

## Why this is dead code, not "unused-looking code"

The only runtime entrypoints are `src/main.ts` and `api/index.ts` (Vercel).

| Entrypoint | Imports |
| --- | --- |
| `api/index.ts` | `../src/env`, `../src/app.module` |
| `src/main.ts` | `./env`, `./config/env.validation`, `./data-source`, `./app.module` |
| `src/app.module.ts` | `express`, `cors`, `cookie-parser`, `./data-source`, hand-rolled routers, `helmet`, local middleware, `./swagger` |
| `src/data-source.ts` | `mongoose` **only** — no `typeorm`, no `pg` |

Measured, not inferred:

- `NestFactory` and `from '@nestjs/core'` appear **nowhere** in `src/`.
- `grep -rln "typeorm\|@nestjs\|class-validator\|class-transformer\|reflect-metadata" src --include='*.ts' | grep -v '^src/modules/'` → **empty**. Nothing outside `src/modules/` references any of them.
- The only `@/modules/...` imports in the repo are *inside* `src/modules/` (entities referencing each other).
- Only two config files mention the stack at all: `nest-cli.json` and `package.json`.

So the 6 "production dependency" advisories the P1.5 audit attributed to this tree
(`@nestjs/core` GHSA-36xv-jgw5-4q75, `file-type`, `lodash` via `@nestjs/config`,
`uuid` via `@nestjs/typeorm`, `body-parser` and `qs` via `@nestjs/platform-express`)
are real advisories in code that never loads. The remaining `@nestjs/cli` findings
are build tooling that this repo's scripts never invoke (`build` is `tsc`, `dev` is
`tsx watch`).

## Exact file list — 26 files, 631 lines of TypeScript

```
src/modules/cart/cart.controller.ts
src/modules/cart/cart.module.ts
src/modules/cart/cart.service.ts
src/modules/cart/dto/add-to-cart.dto.ts
src/modules/cart/entities/cart-item.entity.ts
src/modules/categories/categories.controller.ts
src/modules/categories/categories.module.ts
src/modules/categories/categories.service.ts
src/modules/categories/dto/.gitkeep
src/modules/categories/entities/category.entity.ts
src/modules/orders/dto/create-order.dto.ts
src/modules/orders/entities/order.entity.ts
src/modules/orders/entities/order-item.entity.ts
src/modules/orders/orders.controller.ts
src/modules/orders/orders.module.ts
src/modules/orders/orders.service.ts
src/modules/products/dto/create-product.dto.ts
src/modules/products/dto/update-product.dto.ts
src/modules/products/entities/product.entity.ts
src/modules/products/products.controller.ts
src/modules/products/products.module.ts
src/modules/products/products.service.ts
src/modules/users/entities/user.entity.ts
src/modules/users/users.controller.ts
src/modules/users/users.module.ts
src/modules/users/users.service.ts
```

Regenerate this list with:
`find src/modules -type f | sort` — and compare before deleting.

## Dependencies to prune (after the files are gone, and only after `npm ls` confirms none is referenced)

`dependencies` — 13 entries:
`@nestjs/common`, `@nestjs/config`, `@nestjs/core`, `@nestjs/jwt`,
`@nestjs/mapped-types`, `@nestjs/passport`, `@nestjs/platform-express`,
`@nestjs/typeorm`, `typeorm`, `pg`, `class-validator`, `class-transformer`,
`reflect-metadata`

`devDependencies` — 3 entries:
`@nestjs/cli`, `@nestjs/schematics`, `ts-loader`

Files — 1:
`nest-cli.json`

**Not in the list, deliberately:** `zod`, `joi`, `multer`, `express`,
`mongoose`, `swagger-jsdoc`, `cookie-parser`, `cors`, `helmet`, `jsonwebtoken`,
`bcryptjs`, `dotenv`, `google-auth-library`, `passport`/`passport-jwt`
(referenced by `src/middleware/auth.middleware.ts`), `express-rate-limit`,
`tsconfig-paths`, `rxjs`, `swagger-ui-express`, `@imagekit/nodejs`. Verify each
with a grep before removing anything not on this list; a stale `tsconfig-paths`
entry in `start:prod` is a known trap in this repo (see the dotenv import-order
note in `/memories/repo/mioralane-backend.md`).

## Verification protocol (the "control")

There is no deliberate-break control for a deletion. The control is a **before/after
comparison of the route inventory**, because the one thing deletion can silently
break is a route that was mounted from a file we removed:

1. **Before**, on the current commit:
   - `npm run verify:route-guards > /tmp/guards-before.txt` (24 checks; it walks the
     real routers statically and asserts guard coverage, ordering, and a 25-site
     `ObjectId.isValid` canary).
   - Record the inventory it derives. It parses `app.module.ts` and each router
     statically, so the *set* of mounted paths must be identical afterwards.
   - `npm run verify:types` — the test tsconfig currently type-checks `src/modules`.
2. **Delete** `src/modules/**`, `nest-cli.json`, then prune the 16 dependencies.
3. **After**:
   - `npm run verify:route-guards > /tmp/guards-after.txt` and **diff the two files**.
     A difference is a failure, not a re-baseline.
   - `npx tsc --noEmit`, `npm run verify:types`, all 9 harnesses (703 checks),
     `npm run build`.
   - `test ! -d dist/modules` — tsc must no longer emit the tree.
   - `npm ls @nestjs/common @nestjs/core typeorm pg class-validator reflect-metadata`
     → all `UNMET`/absent (the tree, not just `package.json`, is clean).
   - `npm audit --json` → record the new total. Expect a large drop; **measure it,
     do not assume a number** — the remaining findings should be confined to the
     `swagger-jsdoc` chain (`js-yaml`, `fast-uri`, `brace-expansion`, already
     refreshed in P1.5c) and any dev tooling that survives.
4. **Delete `dist/modules/**`** as well — the built output carries the old tree
   until the next clean build, and a stale `dist` is what a runtime deploy would
   pick up if `npm run start` were ever used instead of `api/index.ts`.

## Open questions to answer in that block (not blockers)

- `src/modules/categories/dto/.gitkeep` implies a `Category` DTO was planned. If
  the intent was to keep the Nest scaffold for future work, the alternative to
  deletion is moving it to a branch rather than keeping dead code in `src/` — but
  then it must be excluded from `tsconfig` so it stops being audited and compiled.
- `@nestjs/mapped-types` provides `PartialType`, which the products DTO uses; the
  hand-rolled Zod schemas in `src/product/product.schemas.ts` already cover the same
  ground, so nothing needs porting.
