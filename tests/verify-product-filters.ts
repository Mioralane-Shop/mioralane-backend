/**
 * Product list filters — the `ingredient` query parameter.
 *
 * Run with: npm run verify:product-filters
 *
 * ## What this covers
 *
 * `buildIngredientCondition` is pure, so it is asserted directly:
 *
 *   - An empty, blank or comma-only value must produce NO condition. Never an
 *     `$in: []` — that is a filter which matches nothing and would present
 *     itself as an empty catalog rather than as a bug.
 *   - A value must reach BOTH the free-text `ingredients` paragraph and each
 *     `keyIngredients[].name`, because a product may carry either.
 *   - A value containing regex metacharacters must be escaped rather than
 *     compiled. `vitamin c (` as a raw pattern is an unterminated group, which
 *     throws inside the request handler.
 *
 * ## Why there is no HTTP check here
 *
 * `GET /api/products?ingredient=retinol` returning rows is deliberately NOT
 * asserted, because this repo has nothing to run it against: there is no test
 * framework, no `mongodb-memory-server` and no request-level stub, and
 * `getProducts` executes its query through the real `Product` model. A check
 * that stubbed the Mongoose chain would assert the stub, not the filter. The
 * coverage is deferred knowingly rather than faked.
 *
 * The wiring check that matters most is the silent one: the list route must not
 * run `validate({ query })`. A Zod schema that omits `ingredient` would strip
 * the parameter before the controller ever sees it, and the filter would no-op
 * with no error in any log — the endpoint would answer 200 with everything.
 *
 * Exits non-zero if any check fails.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIngredientCondition } from '../src/product/product.controller';

const PRODUCT_CONTROLLER_FILE = join(__dirname, '..', 'src', 'product', 'product.controller.ts');
const PRODUCT_ROUTES_FILE = join(__dirname, '..', 'src', 'product', 'product.routes.ts');

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
 * The shape the builder returns, declared narrowly so the checks can read it.
 * A `Record<string, { $in?: RegExp[] }>` would not do: every key would then map
 * to `{ $in? }`, and `.$in` would read as an object rather than a pattern list.
 * Only `$in` is ever inspected.
 */
type IngredientClause = {
    ingredients?: { $in?: RegExp[] };
    'keyIngredients.name'?: { $in?: RegExp[] };
};

type IngredientCondition = { $or?: IngredientClause[] };

const conditionFor = (values: string[]): IngredientCondition | null =>
    buildIngredientCondition(values) as unknown as IngredientCondition | null;

/** The key name of each `$or` clause, so the two shapes the filter checks are visible. */
const clauseKeys = (condition: IngredientCondition | null): string =>
    (condition?.$or ?? []).map((clause) => Object.keys(clause).join('+')).join(',');

/** The patterns in clause 0 (`ingredients`) or clause 1 (`keyIngredients.name`). */
const patternsFor = (condition: IngredientCondition | null, index: number): RegExp[] => {
    const clause = (condition?.$or ?? [])[index];

    if (!clause) {
        return [];
    }

    return index === 0
        ? clause.ingredients?.$in ?? []
        : clause['keyIngredients.name']?.$in ?? [];
};

/* ───────────────────────────── checks ───────────────────────────── */

const main = (): void => {
    /* ── A. the condition the parameter builds ────────────────────────── */
    section('A. buildIngredientCondition — the filter `?ingredient=` builds');

    check(
        'an empty value list produces NO condition, so the list stays unfiltered',
        buildIngredientCondition([]) === null,
        String(buildIngredientCondition([]))
    );
    check(
        'blank and whitespace-only entries are discarded, not compiled',
        conditionFor(['', '   ', '\t']) === null,
        'NEGATIVE CONTROL: `$in: []` matches nothing and would read as an empty catalog'
    );

    const single = conditionFor(['retinol']);

    check(
        'a value produces an $or across exactly the two ingredient shapes',
        single !== null && (single.$or ?? []).length === 2,
        `$or clauses: ${clauseKeys(single) || '(none)'}`
    );
    check(
        'both shapes are checked, so a key-ingredient-only product is still found',
        clauseKeys(single) === 'ingredients,keyIngredients.name' &&
            patternsFor(single, 0).length === 1 &&
            patternsFor(single, 1).length === 1,
        `${clauseKeys(single) || '(none)'} — ${patternsFor(single, 0).length}/${patternsFor(single, 1).length} patterns`
    );
    check(
        'the pattern is a case-insensitive substring match, not an exact one',
        patternsFor(single, 0)[0]?.test('Water, Retinol, Glycerin') === true &&
            patternsFor(single, 0)[0]?.test('retinol') === true &&
            patternsFor(single, 0)[0]?.test('tretinoin') === false,
        String(patternsFor(single, 0)[0])
    );
    check(
        'a comma-separated value becomes one pattern per term, in order',
        patternsFor(conditionFor(['retinol', 'centella']), 0)
            .map((pattern) => pattern.source)
            .join('|') === 'retinol|centella',
        patternsFor(conditionFor(['retinol', 'centella']), 0).map((p) => p.source).join('|')
    );
    check(
        'a repeated value is compiled once',
        patternsFor(conditionFor(['retinol', 'retinol', ' retinol ']), 0).length === 1,
        `${patternsFor(conditionFor(['retinol', 'retinol', ' retinol ']), 0).length} patterns`
    );
    check(
        'regex metacharacters are escaped rather than compiled',
        patternsFor(conditionFor(['vitamin c (']), 0)[0]?.source === 'vitamin c \\(',
        String(patternsFor(conditionFor(['vitamin c (']), 0)[0]?.source)
    );
    check(
        'POSITIVE CONTROL: the escaping is load-bearing — the raw value would throw',
        (() => {
            try {
                new RegExp('vitamin c (');
                return false;
            } catch {
                return true;
            }
        })(),
        'an unescaped `(` is an unterminated group: this is why escapeRegex runs first'
    );

    /* ── B. wiring ────────────────────────────────────────────────────── */
    section('B. Wiring: the controller reads it, and the route does not strip it');

    const controllerSource = readFileSync(PRODUCT_CONTROLLER_FILE, 'utf8');
    const routesSource = readFileSync(PRODUCT_ROUTES_FILE, 'utf8');

    check(
        'getProducts declares and destructures the parameter',
        controllerSource.includes('ingredient?: string;') &&
            controllerSource.includes('buildIngredientCondition(splitCsv(ingredient))'),
        'the filter is built from a value the controller never reads'
    );
    check(
        'the condition is appended only when it is non-null',
        controllerSource.includes('if (ingredientCondition) andConditions.push(ingredientCondition);'),
        'an unconditional push would put a null into the query'
    );

    const listRegistration =
        routesSource.split('\n').find((line) => line.includes("router.get('/',")) ?? '';

    check(
        'the list route runs NO query schema, so Zod cannot strip `ingredient`',
        listRegistration.includes('getProducts') && !listRegistration.includes('validate('),
        listRegistration.trim() || "no router.get('/') registration found in product.routes.ts"
    );

    /* ── Result ────────────────────────────────────────────────────────── */
    console.log('\n=== Result ===');

    if (failures.length > 0) {
        console.log(`FAILED (${failures.length}):`);

        for (const failure of failures) {
            console.log(`  - ${failure}`);
        }

        // exitCode rather than process.exit(): tearing the process down while
        // the runtime still holds handles trips a libuv assertion on Windows.
        process.exitCode = 1;
        return;
    }

    console.log('All product filter checks passed.');
};

main();
