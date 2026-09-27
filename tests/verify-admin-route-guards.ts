/**
 * P0-2 — Admin route guard verification.
 *
 * Run with: npm run verify:route-guards
 *
 * Three independent checks, all dependency-free:
 *
 *  A. Guard coverage. Parses `src/app.module.ts` (mounts) plus every
 *     ".routes.ts" file under `src` (routers and their registrations), and
 *     fails when a route mounted under `/api/admin/*` is missing `protect` +
 *     `adminOnly`, applied inline or by a covering router-level
 *     `use(...adminGuard)`. It also fails on a reversed inline order
 *     (`adminOnly` appearing before `protect`).
 *
 *  A2. Guard coverage for the admin-guarded routers that are mounted OUTSIDE
 *     `/api/admin` (product, combo, media, activity-log). Check A cannot see
 *     them. For the routers that also serve public GETs, the public GETs are
 *     additionally asserted to be UNguarded, because adding a router-level
 *     guard there would lock the storefront out. The one intentionally public
 *     non-GET route is declared as an explicit, reasoned exception rather than
 *     by loosening the rule.
 *
 *  B. ObjectId canary. Asserts the 25 `:id` guards found during the P0-2 audit
 *     are still present. These live in controllers and services rather than in
 *     route files, so check A cannot see them; this turns that manual audit
 *     into a regression net. Counts are per file and exact — if an intentional
 *     refactor moves one of these, update the entry below.
 *
 *  B2. Relocated-guard canary. P0-3.4 deleted `submitReview`'s hand-rolled
 *     `isValidObjectId(productId)` check, which made the check B count for
 *     `review.service.ts` drop from 6 to 5. The guarantee was moved, not
 *     dropped — it now lives in `createReviewSchema`'s 24-hex pattern enforced
 *     by `validate()`. Check B cannot see that coupling, so it is asserted
 *     explicitly here. If either half is removed, the ObjectId guard on review
 *     submission is genuinely gone and this check fails.
 *
 *  C. Guard-chain runtime contract. Proves `adminGuard` holds the original
 *     `protect`/`adminOnly` function references (no wrapper), and that
 *     registering an async handler through a spread array still lets Express 5
 *     forward a rejection instead of hanging the request.
 *
 * Exits non-zero if any check fails.
 */
import { readdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import express, { type RequestHandler } from 'express';
import { adminGuard, adminOnly, protect } from '../src/middleware/auth.middleware';

type Failure = string;

const failures: Failure[] = [];
const fail = (message: Failure): void => {
    failures.push(message);
};

const SRC_DIR = join(__dirname, '..', 'src');
const APP_MODULE_FILE = join(SRC_DIR, 'app.module.ts');

const readText = (file: string): string => readFileSync(file, 'utf8');

/**
 * Removes `//` line comments and block comments while preserving quoted string
 * literals.
 *
 * This is required, not cosmetic: without it a guard that was disabled by
 * COMMENTING IT OUT is still found by the plain-text call scanner and counted
 * as present. The negative controls caught exactly that false negative.
 */
const stripComments = (source: string): string => {
    let output = '';
    let index = 0;
    let quote: string | null = null;

    while (index < source.length) {
        const char = source[index];
        const next = source[index + 1];

        if (quote !== null) {
            output += char;

            if (char === '\\') {
                output += next ?? '';
                index += 2;
                continue;
            }

            if (char === quote) {
                quote = null;
            }

            index += 1;
            continue;
        }

        if (char === "'" || char === '"' || char === '`') {
            quote = char;
            output += char;
            index += 1;
            continue;
        }

        if (char === '/' && next === '/') {
            while (index < source.length && source[index] !== '\n') {
                index += 1;
            }
            continue;
        }

        if (char === '/' && next === '*') {
            index += 2;
            while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
                index += 1;
            }
            index += 2;
            continue;
        }

        output += char;
        index += 1;
    }

    return output;
};

/** Source with comments removed — used for every structural parse. */
const readCode = (file: string): string => stripComments(readText(file));

/** Relative-to-src path, used for readable output on any OS. */
const shortPath = (file: string): string => file.slice(SRC_DIR.length + 1).split('\\').join('/');

const listRouteFiles = (dir: string): string[] => {
    const found: string[] = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);

        if (entry.isDirectory()) {
            found.push(...listRouteFiles(full));
            continue;
        }

        if (entry.isFile() && entry.name.endsWith('.routes.ts')) {
            found.push(full);
        }
    }

    return found;
};

/**
 * Returns every `needle` call (needle includes the opening paren) with its
 * argument text and the source index of the call. A paren-depth scan is used so
 * multi-line registrations and nested calls such as
 * `swaggerSetup(spec, { ... })` are handled correctly. The index lets check A
 * assert that a router-level guard is registered *before* the routes it must
 * protect — a guard added afterwards would silently leave them open.
 */
const extractCallArgs = (source: string, needle: string): Array<{ args: string; index: number }> => {
    const results: Array<{ args: string; index: number }> = [];
    let index = source.indexOf(needle);

    while (index !== -1) {
        const open = index + needle.length;
        // Depth starts at 1: the opening paren is part of `needle` and has already
        // been consumed, so the matching close is the one that returns us to 0.
        let depth = 1;
        let cursor = open;

        for (; cursor < source.length; cursor += 1) {
            const char = source[cursor];

            if (char === '(') {
                depth += 1;
            } else if (char === ')') {
                depth -= 1;
                if (depth === 0) {
                    break;
                }
            }
        }

        if (depth !== 0) {
            break;
        }

        results.push({ args: source.slice(open, cursor), index });
        index = source.indexOf(needle, cursor + 1);
    }

    return results;
};

const joinPaths = (mount: string, routePath: string): string => {
    const base = mount.endsWith('/') && mount.length > 1 ? mount.slice(0, -1) : mount;
    const sub = routePath.startsWith('/') ? routePath : `/${routePath}`;

    return `${base}${sub}` || '/';
};

const covers = (prefix: string, routePath: string): boolean => {
    if (prefix === '' || prefix === '/') {
        return true;
    }

    return routePath === prefix || routePath.startsWith(`${prefix}/`);
};

type RegisteredRoute = {
    ident: string;
    file: string;
    method: string;
    path: string;
    args: string;
    /** Source index of the registration, used to compare against guard position. */
    orderIndex: number;
    inlineProtect: boolean;
    inlineAdminOnly: boolean;
    /** True when the registration spreads `...adminGuard` inline. */
    inlineAdminGuard: boolean;
};

type RouterInfo = {
    ident: string;
    file: string;
    routes: RegisteredRoute[];
    /** Router-level `use(...adminGuard)` calls; prefix '' means no path restriction. */
    guards: Array<{ prefix: string; index: number }>;
};

const ROUTER_DEFINITION = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*Router\(\)/g;
const ROUTE_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'] as const;

const findRouter = (routers: RouterInfo[], file: string, ident: string): RouterInfo | undefined =>
    routers.find((router) => router.file === file && router.ident === ident);

/**
 * Route files expose their router either as a named export (`export const X =
 * Router()`) or as `export default router`. app.module.ts imports both shapes,
 * so the mount name in app.module.ts must be resolved through the import
 * statement rather than assumed to equal the identifier in the route file.
 */
const resolveModuleFile = (modulePath: string): string =>
    `${join(SRC_DIR, modulePath.replace(/^\.\//, ''))}.ts`;

const collectImportedRouters = (routers: RouterInfo[]): Map<string, RouterInfo> => {
    const source = readCode(APP_MODULE_FILE);
    const byLocalName = new Map<string, RouterInfo>();

    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
        const file = resolveModuleFile(match[2]);

        if (!file.endsWith('.routes.ts')) {
            continue;
        }

        for (const rawName of match[1].split(',')) {
            const parts = rawName.trim().split(/\s+as\s+/);
            const ident = parts[0];
            const localName = parts[1] ?? parts[0];
            const router = ident ? findRouter(routers, file, ident) : undefined;

            if (router) {
                byLocalName.set(localName, router);
            }
        }
    }

    for (const match of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s*'([^']+)'/g)) {
        const file = resolveModuleFile(match[2]);

        if (!file.endsWith('.routes.ts')) {
            continue;
        }

        const defaultMatch = readCode(file).match(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;/);
        const router = defaultMatch ? findRouter(routers, file, defaultMatch[1]) : undefined;

        if (router) {
            byLocalName.set(match[1], router);
        }
    }

    return byLocalName;
};

const collectRouters = (): RouterInfo[] => {
    const routers: RouterInfo[] = [];

    for (const file of listRouteFiles(SRC_DIR)) {
        const source = readCode(file);
        const idents = new Set<string>();

        for (const match of source.matchAll(ROUTER_DEFINITION)) {
            idents.add(match[1]);
        }

        for (const ident of idents) {
            const routes: RegisteredRoute[] = [];

            for (const method of ROUTE_METHODS) {
                for (const call of extractCallArgs(source, `${ident}.${method}(`)) {
                    const pathMatch = call.args.match(/^\s*'([^']*)'/);

                    if (!pathMatch) {
                        continue;
                    }

                    routes.push({
                        ident,
                        file,
                        method: method.toUpperCase(),
                        path: pathMatch[1],
                        args: call.args,
                        orderIndex: call.index,
                        inlineProtect: call.args.indexOf('protect') !== -1,
                        inlineAdminOnly: call.args.indexOf('adminOnly') !== -1,
                        inlineAdminGuard: call.args.indexOf('adminGuard') !== -1,
                    });
                }
            }

            const guards = extractCallArgs(source, `${ident}.use(`)
                .filter((call) => call.args.includes('adminGuard'))
                .map((call) => {
                    const pathMatch = call.args.match(/^\s*'([^']*)'/);

                    return { prefix: pathMatch ? pathMatch[1] : '', index: call.index };
                });

            routers.push({ ident, file, routes, guards });
        }
    }

    return routers;
};

const collectMounts = (): Array<{ path: string; args: string }> => {
    const source = readCode(APP_MODULE_FILE);

    return extractCallArgs(source, 'app.use(')
        .map((call) => {
            const pathMatch = call.args.match(/^\s*'([^']*)'/);
            return pathMatch ? { path: pathMatch[1], args: call.args } : null;
        })
        .filter((entry): entry is { path: string; args: string } => entry !== null);
};

/** Check A — every route mounted under /api/admin is guarded. */
const checkAdminGuardCoverage = (routers: RouterInfo[]): void => {
    const importedRouters = collectImportedRouters(routers);
    const mounts = collectMounts();
    const rows: string[] = [];
    let adminRouteCount = 0;

    for (const mount of mounts) {
        for (const [localName, router] of importedRouters) {
            if (!new RegExp(`\\b${localName}\\b`).test(mount.args)) {
                continue;
            }

            const isAdminMount = mount.path.startsWith('/api/admin');

            for (const route of router.routes) {
                const fullPath = joinPaths(mount.path, route.path);
                const coveringGuard = router.guards.find((guard) => covers(guard.prefix, route.path));
                const inline =
                    route.inlineAdminGuard || (route.inlineProtect && route.inlineAdminOnly);
                const source = inline
                    ? 'inline'
                    : coveringGuard !== undefined
                        ? `router.use(${coveringGuard.prefix === '' ? '/' : coveringGuard.prefix})`
                        : 'NONE';

                if (!inline && coveringGuard && route.orderIndex < coveringGuard.index) {
                    fail(
                        `router-level guard registered AFTER the route it must protect: ${route.method} ${fullPath} (${shortPath(route.file)})`,
                    );
                }

                if (isAdminMount) {
                    adminRouteCount += 1;
                    rows.push(
                        `${route.method.padEnd(6)} ${fullPath.padEnd(42)} ${source.padEnd(18)} [${shortPath(route.file)}]`,
                    );

                    if (source === 'NONE') {
                        fail(`unguarded admin route: ${route.method} ${fullPath} (${shortPath(route.file)})`);
                    }
                }

                if (route.inlineAdminOnly && !route.inlineProtect) {
                    fail(
                        `adminOnly without protect: ${route.method} ${fullPath} (${shortPath(route.file)})`,
                    );
                }

                if (inline && route.args.indexOf('adminOnly') < route.args.indexOf('protect')) {
                    fail(`reversed guard order: ${route.method} ${fullPath} (${shortPath(route.file)})`);
                }
            }
        }
    }

    console.log(`\n=== A. Admin route guard coverage (${adminRouteCount} routes) ===`);
    for (const row of rows.sort()) {
        console.log(`  ${row}`);
    }

    if (adminRouteCount === 0) {
        fail('no /api/admin routes were discovered — the parser is probably broken');
    }
};

/**
 * Admin-guarded routers that are deliberately NOT mounted under `/api/admin`.
 *
 * `scope` is explicit because the risk differs per router:
 *  - 'non-get': public GETs must stay open, so only write methods are asserted
 *    (and the public GETs are asserted to remain unguarded).
 *  - 'all': an audit surface where even GETs must be admin-only — asserting
 *    writes only would make the check vacuous, since every route here is a GET.
 */
const ADMIN_GUARDED_ROUTERS_OUTSIDE_ADMIN_MOUNT: Array<{
    file: string;
    ident: string;
    scope: 'non-get' | 'all';
    note: string;
    /**
     * Registrations that are intentionally public even though they are not GETs.
     * Declared explicitly (with a reason) instead of loosening the rule, so any
     * NEW unguarded write on these routers still fails the check. Stale entries
     * are themselves a failure.
     */
    publicExceptions?: Array<{ method: string; path: string; reason: string }>;
}> = [
        {
            file: 'product/product.routes.ts',
            ident: 'router',
            scope: 'non-get',
            note: 'storefront catalog GETs + admin writes',
            publicExceptions: [
                {
                    method: 'POST',
                    path: '/recommendations/cart',
                    reason:
                        'guest cart cross-sell lookup — a read, so POST is only used to carry productIds in the body',
                },
            ],
        },
        {
            file: 'combo/combo.routes.ts',
            ident: 'router',
            scope: 'non-get',
            note: 'storefront combo GETs + admin writes',
        },
        {
            file: 'media/media.routes.ts',
            ident: 'router',
            scope: 'non-get',
            note: 'admin image endpoints (future customer /review-images stays open)',
        },
        {
            file: 'activity-log/activity-log.routes.ts',
            ident: 'activityLogRoutes',
            scope: 'all',
            note: 'audit surface — even GETs are admin-only',
        },
    ];

const isRouteGuarded = (route: RegisteredRoute, router: RouterInfo): boolean =>
    route.inlineAdminGuard ||
    (route.inlineProtect && route.inlineAdminOnly) ||
    router.guards.some((guard) => covers(guard.prefix, route.path));

/** Check A2 — the admin-guarded routers that live outside /api/admin. */
const checkNonAdminMountedGuardCoverage = (routers: RouterInfo[]): void => {
    console.log('\n=== A2. Admin-guarded routers outside /api/admin ===');
    let checked = 0;

    for (const entry of ADMIN_GUARDED_ROUTERS_OUTSIDE_ADMIN_MOUNT) {
        const file = join(SRC_DIR, entry.file);
        const router = findRouter(routers, file, entry.ident);

        if (!router) {
            fail(`declared admin router not found: ${entry.file}::${entry.ident}`);
            console.log(`  FAIL ${entry.file}::${entry.ident} — router not found`);
            continue;
        }

        const exceptions = entry.publicExceptions ?? [];
        const targets = (
            entry.scope === 'all'
                ? router.routes
                : router.routes.filter((route) => route.method !== 'GET')
        ).filter(
            (route) =>
                !exceptions.some(
                    (exception) =>
                        exception.method === route.method && exception.path === route.path,
                ),
        );

        for (const exception of exceptions) {
            const declared = router.routes.find(
                (route) => route.method === exception.method && route.path === exception.path,
            );

            if (!declared) {
                fail(
                    `stale public exception — route no longer exists: ${exception.method} ${exception.path} (${entry.file})`,
                );
            } else if (isRouteGuarded(declared, router)) {
                fail(
                    `stale public exception — route is in fact guarded: ${exception.method} ${exception.path} (${entry.file})`,
                );
            }
        }

        if (targets.length === 0) {
            fail(`declared admin router has no routes to verify: ${entry.file}::${entry.ident}`);
            console.log(`  FAIL ${entry.file}::${entry.ident} — no routes found (parser drift?)`);
            continue;
        }

        for (const route of targets) {
            checked += 1;

            if (!isRouteGuarded(route, router)) {
                fail(
                    `unguarded admin route outside /api/admin: ${route.method} ${route.path} (${entry.file})`,
                );
                console.log(
                    `  FAIL ${route.method.padEnd(6)} ${route.path.padEnd(28)} [${entry.file}]`,
                );
            }
        }

        if (entry.scope === 'non-get') {
            for (const route of router.routes.filter((item) => item.method === 'GET')) {
                if (isRouteGuarded(route, router)) {
                    fail(
                        `public GET is guarded — this would break the storefront: ${route.method} ${route.path} (${entry.file})`,
                    );
                    console.log(
                        `  FAIL public GET is guarded: ${route.path.padEnd(22)} [${entry.file}]`,
                    );
                }
            }
        }

        console.log(
            `  OK   ${entry.file.padEnd(36)} ${targets.length} route(s), scope=${entry.scope} — ${entry.note}`,
        );
    }

    console.log(`  admin-guarded routes checked outside /api/admin: ${checked}`);
};

type Canary = { file: string; pattern: RegExp; min: number; note: string };

/** Check B — the 25 `:id` ObjectId guards audited in P0-2 must still exist. */
const OBJECT_ID_CANARIES: Canary[] = [
    {
        file: 'customer/admin-customer.controller.ts',
        pattern: /!mongoose\.Types\.ObjectId\.isValid\(customerId\)/g,
        min: 1,
        note: 'getAdminCustomerById',
    },
    {
        file: 'order/admin-order.controller.ts',
        pattern: /!mongoose\.Types\.ObjectId\.isValid\(orderId\)/g,
        min: 2,
        note: 'getAdminOrderById, updateAdminOrderStatus',
    },
    {
        file: 'order/order.controller.ts',
        pattern: /!mongoose\.Types\.ObjectId\.isValid\(orderId\)/g,
        min: 1,
        note: 'getOrderById (customer)',
    },
    {
        file: 'product/product.controller.ts',
        pattern: /!isValidObjectId\(id\)/g,
        min: 3,
        note: 'updateProduct, deleteProduct, markPreOrderArrived',
    },
    {
        file: 'combo/combo.controller.ts',
        pattern: /!isValidObjectId\(id\)/g,
        min: 2,
        note: 'updateCombo, deleteCombo',
    },
    {
        file: 'promotion/promotion-admin.controller.ts',
        pattern: /!isObjectId\(id\)/g,
        min: 6,
        note: 'campaign + coupon handlers',
    },
    {
        file: 'review/review.service.ts',
        pattern: /!isValidObjectId\(/g,
        // Was 6 until P0-3.4. `submitReview`'s own productId check was deleted as
        // unreachable dead code once `validate()` ran first; see
        // ZOD_OBJECT_ID_CANARIES, which proves the guard moved rather than vanished.
        min: 5,
        note: 'admin review id + :productId handlers (submitReview now via Zod)',
    },
    {
        file: 'activity-log/activity-log.service.ts',
        pattern: /!mongoose\.Types\.ObjectId\.isValid\(activityId\)/g,
        min: 1,
        note: 'getActivityLogById',
    },
    {
        file: 'address/address.service.ts',
        pattern: /!mongoose\.Types\.ObjectId\.isValid\(addressId\)/g,
        min: 1,
        note: 'findOwnedAddress (4 handlers)',
    },
    {
        file: 'wishlist/wishlist.controller.ts',
        pattern: /!mongoose\.Types\.ObjectId\.isValid\(raw\)/g,
        min: 1,
        note: 'removeFromWishlist :itemId',
    },
    {
        file: 'inventory/inventory-transaction.service.ts',
        pattern: /!mongoose\.Types\.ObjectId\.isValid\(value\)/g,
        min: 1,
        note: 'toInventoryObjectId (:id, :itemId, :transactionId)',
    },
];

const checkObjectIdCanary = (): void => {
    console.log(`\n=== B. ObjectId :id guard canary (${OBJECT_ID_CANARIES.length} files) ===`);
    let total = 0;

    for (const canary of OBJECT_ID_CANARIES) {
        const source = readCode(join(SRC_DIR, canary.file));
        const found = source.match(canary.pattern)?.length ?? 0;
        total += found;

        const ok = found >= canary.min;
        console.log(
            `  ${ok ? 'OK  ' : 'FAIL'} ${canary.file.padEnd(46)} ${found}/${canary.min} — ${canary.note}`,
        );

        if (!ok) {
            fail(
                `ObjectId guard removed: ${canary.file} has ${found} of ${canary.min} expected (${canary.note})`,
            );
        }
    }

    console.log(`  total :id guard sites: ${total}`);
};

/**
 * Check B2 — guards that P0-3.x moved out of a service body and into a Zod
 * schema. Each entry is only meaningful together with the others: the schema's
 * pattern without the `validate()` wiring does nothing, and the wiring without
 * the pattern validates nothing.
 */
const ZOD_OBJECT_ID_CANARIES: Canary[] = [
    {
        file: 'review/review.schemas.ts',
        // Matches the literal `/^[0-9a-fA-F]{24}$/` source text, not a negated class.
        pattern: /\^\[0-9a-fA-F\]\{24\}/g,
        min: 1,
        note: 'createReviewSchema.productId 24-hex pattern',
    },
    {
        file: 'review/review.routes.ts',
        pattern: /validate\(\{\s*body:\s*createReviewSchema\s*\}\)/g,
        min: 1,
        note: 'validate() actually wired to createReviewSchema',
    },
];

const checkZodObjectIdCanary = (): void => {
    console.log(`\n=== B2. relocated ObjectId guards (${ZOD_OBJECT_ID_CANARIES.length} files) ===`);

    for (const canary of ZOD_OBJECT_ID_CANARIES) {
        const source = readCode(join(SRC_DIR, canary.file));
        const found = source.match(canary.pattern)?.length ?? 0;
        const ok = found >= canary.min;

        console.log(
            `  ${ok ? 'OK  ' : 'FAIL'} ${canary.file.padEnd(46)} ${found}/${canary.min} — ${canary.note}`,
        );

        if (!ok) {
            fail(
                `Relocated ObjectId guard missing: ${canary.file} has ${found} of ${canary.min} expected (${canary.note})`,
            );
        }
    }
};

/** Check C — guard chain identity + Express 5 async rejection forwarding. */
const checkGuardChainRuntime = async (): Promise<void> => {
    console.log('\n=== C. Guard chain runtime contract ===');

    if (adminGuard.length !== 2) {
        fail(`adminGuard must hold exactly 2 middlewares, found ${adminGuard.length}`);
    }

    if (!Object.isFrozen(adminGuard)) {
        fail(
            'adminGuard is not frozen — a runtime mutation could silently weaken every admin route at once',
        );
    } else {
        console.log('  OK   adminGuard is frozen (Object.isFrozen)');
    }

    // Deliberate type escape to prove the freeze is enforced, not just declared.
    let mutationRejected = false;
    try {
        (adminGuard as RequestHandler[]).push(((_req, _res, next) => {
            next();
        }) as RequestHandler);
    } catch {
        mutationRejected = true;
    }

    if (!mutationRejected) {
        fail('adminGuard accepted a runtime mutation — the freeze is not effective');
    } else {
        console.log('  OK   mutating adminGuard throws (freeze is enforced)');
    }

    if (adminGuard[0] !== (protect as unknown as RequestHandler)) {
        fail('adminGuard[0] is not the original protect function reference');
    } else {
        console.log('  OK   adminGuard[0] === protect (no wrapper; the cast is type-level only)');
    }

    if (adminGuard[1] !== (adminOnly as unknown as RequestHandler)) {
        fail('adminGuard[1] is not the original adminOnly function reference');
    } else {
        console.log('  OK   adminGuard[1] === adminOnly');
    }

    const app = express();
    const rejecting: RequestHandler = async () => {
        throw new Error('async rejection probe');
    };
    const chain: RequestHandler[] = [
        ((_req, _res, next) => {
            next();
        }) as RequestHandler,
        rejecting,
    ];

    const router = express.Router();
    router.use(...chain);
    router.get(
        '/probe',
        ((_req, res) => {
            res.json({ reached: true });
        }) as RequestHandler,
    );
    app.use('/probe-mount', router);

    const server = await new Promise<Server>((resolve) => {
        const listening = app.listen(0, () => resolve(listening));
    });

    try {
        const address = server.address();
        const port = address && typeof address === 'object' ? address.port : 0;
        const response = await fetch(`http://127.0.0.1:${port}/probe-mount/probe`, {
            signal: AbortSignal.timeout(4000),
        });

        if (response.status === 500) {
            console.log('  OK   async rejection in an array-registered chain reached the error handler');
        } else {
            fail(`async rejection was not forwarded (status ${response.status}, expected 500)`);
        }
    } catch (error) {
        fail(
            `async rejection was swallowed — request hung or failed: ${error instanceof Error ? error.message : String(error)
            }`,
        );
    } finally {
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    }
};

const main = async (): Promise<void> => {
    const routers = collectRouters();

    checkAdminGuardCoverage(routers);
    checkNonAdminMountedGuardCoverage(routers);
    checkObjectIdCanary();
    checkZodObjectIdCanary();
    await checkGuardChainRuntime();

    console.log('\n=== Result ===');

    if (failures.length > 0) {
        console.log(`FAILED (${failures.length}):`);
        for (const failure of failures) {
            console.log(`  - ${failure}`);
        }
        process.exit(1);
    }

    console.log('All admin route guard checks passed.');
};

void main();
