/**
 * Brand module — the API surface, the request schemas, and the two filters that
 * decide what the storefront is shown.
 *
 * Run with: npm run verify:brand
 *
 * ## What this covers
 *
 * The things that are decidable without a database:
 *
 *   - **Route registration order.** `PATCH /reorder` must be registered before
 *     `PATCH /:id`, or Express binds `id = 'reorder'`, the param schema refuses it,
 *     and the bulk reorder becomes permanently unreachable — a 400 that looks like
 *     a client bug. Express matches in registration order, so source order *is*
 *     the behaviour, and comparing the two offsets tests it exactly.
 *   - **Guards.** Both public routes unguarded, and the admin router guarded once
 *     at the router level rather than per route, so a route added later inherits it.
 *   - **The request schemas**, as pure functions: `safeUrlSchema` refuses
 *     `javascript:` / protocol-relative / `data:`, unknown keys are stripped so
 *     server-owned fields cannot be injected, a blank logo URL is "not supplied"
 *     rather than an error, a cleared dimension is absent rather than `0`.
 *   - **`reorder` takes a bare array**, refuses an empty one and a duplicate id.
 *   - **Serialization and snapshots**: `id` not `_id`, and `updatedAt` kept out of
 *     the audit snapshot so a no-op save does not log a change.
 *
 * ## What it deliberately does not cover, and why
 *
 * No endpoint is exercised. This repo has no test framework, no
 * `mongodb-memory-server` and no request-level stub, so every handler here would
 * reach a real `Brand.find()`/`bulkWrite()`. A check that stubbed the Mongoose
 * chain would assert the stub rather than the query. The two filters that matter —
 * "visible and ordered" and "visible, opted in, and carrying a logo" — are
 * therefore asserted against the source that builds them, alongside the reason
 * `$exists` is required next to `$nin`.
 *
 * Exits non-zero if any check fails.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVITY_ENTITY_TYPES } from '../src/activity-log/activity-log.model';
import { brandSnapshot, createBrandError, serializeBrand } from '../src/brand/brand.service';
import {
    createBrandSchema,
    reorderBrandsSchema,
    updateBrandSchema,
} from '../src/brand/brand.schemas';

const SRC_DIR = join(__dirname, '..', 'src');
const BRAND_ROUTES_FILE = join(SRC_DIR, 'brand', 'brand.routes.ts');
const BRAND_SERVICE_FILE = join(SRC_DIR, 'brand', 'brand.service.ts');
const BRAND_CONTROLLER_FILE = join(SRC_DIR, 'brand', 'brand.controller.ts');
const BRAND_MODEL_FILE = join(SRC_DIR, 'brand', 'brand.model.ts');
const ACTIVITY_SERVICE_FILE = join(SRC_DIR, 'activity-log', 'activity-log.service.ts');
const APP_MODULE_FILE = join(SRC_DIR, 'app.module.ts');

const failures: string[] = [];

const check = (label: string, condition: boolean, detail?: string): void => {
    if (condition) {
        console.log(`  OK   ${label}`);
        return;
    }

    console.log(`  FAIL ${label}`);

    if (detail) {
        console.log(`       ${detail}`);
    }

    failures.push(label);
};

const section = (title: string): void => {
    console.log(`\n=== ${title} ===`);
};

/**
 * Comment lines are dropped before any source assertion. A wording or a query
 * filter that only appears in a doc comment — including one of this module's own
 * "why this is here" notes — must not be able to satisfy a check.
 */
const readCode = (file: string): string =>
    readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((line) => {
            const trimmed = line.trim();

            return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
                ? ''
                : line;
        })
        .join('\n');

/* ───────────────────────────── checks ───────────────────────────── */

const routesSource = readFileSync(BRAND_ROUTES_FILE, 'utf8');
const serviceSource = readCode(BRAND_SERVICE_FILE);
const controllerSource = readCode(BRAND_CONTROLLER_FILE);
const modelSource = readCode(BRAND_MODEL_FILE);
const appModuleSource = readCode(APP_MODULE_FILE);

/* ── A. the route surface ─────────────────────────────────────────── */
section('A. The route surface (8 routes, and the order that makes /reorder reachable)');

const reorderIndex = routesSource.indexOf("'/reorder'");
const idIndex = routesSource.indexOf("'/:id'");

check(
    '`/reorder` is registered BEFORE `/:id` — otherwise Express reads "reorder" as an id',
    reorderIndex !== -1 && idIndex !== -1 && reorderIndex < idIndex,
    `reorder@${reorderIndex} /:id@${idIndex}`
);
check(
    'the public router registers exactly the two documented reads',
    routesSource.includes("brandPublicRoutes.get('/', listPublicBrands") &&
        routesSource.includes("brandPublicRoutes.get('/marquee', listMarqueeBrandsHandler"),
    'the public surface is not the documented GET / and GET /marquee'
);

const publicRegistrationLines = routesSource
    .split(/\r?\n/)
    .filter((line) => line.includes('brandPublicRoutes.'));

check(
    'neither public route carries a guard',
    publicRegistrationLines.length === 2 &&
        publicRegistrationLines.every((line) => !/adminGuard|adminOnly|protect\b/.test(line)),
    publicRegistrationLines.join(' | ')
);
check(
    'the admin router is guarded once, at the router level',
    routesSource.includes('adminBrandRoutes.use(...adminGuard)'),
    'a per-route guard would not cover the next route someone adds'
);

const adminRegistrationCount = (routesSource.match(/adminBrandRoutes\.(get|post|patch|delete)\(/g) ?? [])
    .length;

check(
    'the admin router registers all six documented routes',
    adminRegistrationCount === 6,
    `${adminRegistrationCount} registrations found`
);
check(
    'both routers are mounted at the documented paths',
    appModuleSource.includes("app.use('/api/admin/brands', adminBrandRoutes)") &&
        appModuleSource.includes("app.use('/api/brands', brandPublicRoutes)"),
    'app.module.ts does not mount the brand routers'
);

/* ── B. the request schemas, as pure functions ────────────────────── */
section('B. Request schemas');

check(
    'a name alone is a valid create — the slug is derived, not required',
    createBrandSchema.safeParse({ name: 'COSRX' }).success,
    JSON.stringify(createBrandSchema.safeParse({ name: 'COSRX' }))
);
check(
    'the name is trimmed, and a blank name is refused',
    createBrandSchema.parse({ name: '  COSRX  ' }).name === 'COSRX' &&
        !createBrandSchema.safeParse({ name: '   ' }).success
);
check(
    'logoUrl refuses javascript:, a protocol-relative host and data:',
    ['javascript:alert(1)', '//evil.example', 'data:image/svg+xml,<svg/>'].every(
        (logoUrl) => !createBrandSchema.safeParse({ name: 'X', logoUrl }).success
    ),
    'a stored logo URL is bound to an image src, which is the same vector as a stored CTA'
);
check(
    'logoUrl accepts an https URL and a site-relative path',
    ['https://ik.imagekit.io/7sz3r4tou/x/cosrx.svg', '/brands/cosrx.svg'].every(
        (logoUrl) => createBrandSchema.safeParse({ name: 'X', logoUrl }).success
    )
);
check(
    'a blank logoUrl is "not supplied" rather than a validation failure',
    createBrandSchema.safeParse({ name: 'X', logoUrl: '' }).success,
    'clearing a form input must not become an error unrelated to the injection this closes'
);
check(
    'server-owned keys are stripped, so createdAt / _id / __v cannot be injected',
    (() => {
        const parsed = createBrandSchema.parse({
            name: 'X',
            createdAt: '2020-01-01',
            updatedAt: '2020-01-01',
            _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
            id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
            __v: 3,
        }) as Record<string, unknown>;

        return ['createdAt', 'updatedAt', '_id', 'id', '__v'].every((key) => !(key in parsed));
    })(),
    'a body carrying the whole fetched document must not write any of it'
);
check(
    'a logo dimension accepts a numeric string and treats blank as absent, not 0',
    createBrandSchema.parse({ name: 'X', logoWidth: '64' }).logoWidth === 64 &&
        createBrandSchema.parse({ name: 'X', logoWidth: '' }).logoWidth === undefined,
    '`Number("")` is 0, which would reserve a zero-height box'
);
check(
    'an update may be empty — every field is optional',
    updateBrandSchema.safeParse({}).success,
    'a PATCH that changes nothing must not 400'
);
check(
    'reorder accepts a bare array of { id, order }',
    reorderBrandsSchema.safeParse([{ id: 'a'.repeat(24), order: 1 }]).success
);
check(
    'reorder refuses an empty array, a duplicate id, and a non-ObjectId',
    !reorderBrandsSchema.safeParse([]).success &&
        !reorderBrandsSchema.safeParse([
            { id: 'a'.repeat(24), order: 1 },
            { id: 'a'.repeat(24), order: 2 },
        ]).success &&
        !reorderBrandsSchema.safeParse([{ id: 'reorder', order: 1 }]).success,
    'a duplicate id would make the result depend on array order'
);

/* ── C. serialization and audit snapshots ─────────────────────────── */
section('C. Serialization and audit snapshots');

type BrandRecordArg = Parameters<typeof serializeBrand>[0];

const baseRecord = {
    _id: { toString: () => 'abc123' },
    name: 'COSRX',
    slug: 'cosrx',
    showInNavbar: true,
    showInMarquee: false,
    visible: true,
    order: 3,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
} as unknown as BrandRecordArg;

const view = serializeBrand(baseRecord);

check(
    'the view exposes `id` and never `_id` or `__v`',
    view.id === 'abc123' && !('_id' in view) && !('__v' in view),
    JSON.stringify(Object.keys(view))
);
check(
    'a brand with no logo reports `logoUrl: undefined`, not an empty string',
    view.logoUrl === undefined && view.logoAlt === undefined,
    'the storefront tests truthiness, so "" and undefined must not both occur'
);
check(
    'the audit snapshot excludes the timestamps, so a no-op save is not a change',
    !('updatedAt' in brandSnapshot(view)) &&
        !('createdAt' in brandSnapshot(view)) &&
        brandSnapshot(view).order === 3,
    'including updatedAt would report a change on every save'
);
check(
    'createBrandError carries the status and code the controller maps',
    (() => {
        const error = createBrandError(409, 'nope', 'some_code');

        return error.statusCode === 409 && error.code === 'some_code' && error.message === 'nope';
    })()
);

/* ── D. the queries and the audit wiring, read from source ────────── */
section('D. Queries and audit wiring (no database available to exercise them)');

check(
    'the public list is visible-only',
    serviceSource.includes('Brand.find({ visible: true })'),
    'an invisible brand would appear in the storefront'
);
check(
    'the marquee requires the opt-in flag AND a logo, and $nin alone would not',
    serviceSource.includes('showInMarquee: true') &&
        serviceSource.includes("logoUrl: { $exists: true, $nin: [null, ''] }"),
    'without $exists a missing logoUrl also passes $nin, so a blank tile renders'
);
check(
    'both lists sort by order with name as the tiebreaker',
    serviceSource.includes('const BRAND_SORT: Record<string, 1> = { order: 1, name: 1 }'),
    'an unstable order would let two brands at one position swap between requests'
);
check(
    'slug uniqueness is a database index, not a schema check',
    modelSource.includes('BrandSchema.index({ slug: 1 }, { unique: true })'),
    'a pre-check would race and a refine would put a query inside validation'
);
check(
    'every brand mutation is audited as a BRAND entity',
    (controllerSource.match(/entityType: 'BRAND'/g) ?? []).length === 3,
    `${(controllerSource.match(/entityType: 'BRAND'/g) ?? []).length} of create/update/delete audited`
);
check(
    "'BRAND' is a registered audit entity type with a display label",
    (ACTIVITY_ENTITY_TYPES as readonly string[]).includes('BRAND') &&
        readCode(ACTIVITY_SERVICE_FILE).includes("BRAND: 'brand'"),
    'an unwidened union would refuse the write, or a missing label would print the enum'
);
check(
    'a partial reorder is refused rather than reported as success',
    controllerSource.includes('matched !== expected'),
    'a stale id would otherwise return 200 for an order the database does not have'
);

/* ── Result ────────────────────────────────────────────────────────── */
console.log('\n=== Result ===');

if (failures.length > 0) {
    console.log(`FAILED (${failures.length}):`);

    for (const failure of failures) {
        console.log(`  - ${failure}`);
    }

    // exitCode rather than process.exit(): tearing the process down while the
    // runtime still holds handles trips a libuv assertion on Windows.
    process.exitCode = 1;
} else {
    console.log('All brand checks passed.');
}
