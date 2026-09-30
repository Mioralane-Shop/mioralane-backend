/**
 * P1.6.2 — the environment contract at boot.
 *
 * Run with: npm run verify:env-validation
 *
 * `validate()` existed but ran only in `src/main.ts`, the *local* entrypoint.
 * Production runs `api/index.ts`, which never called it — so the deployment booted
 * with whatever it was given, and what it was given was the placeholder
 * `JWT_SECRET` that is committed in this repository. The proof was a one-line
 * probe against the live API:
 *
 *   token signed with PLACEHOLDER_JWT_SECRET -> "User session is no longer valid"
 *   token signed with a different secret     -> "Invalid token"
 *
 * The first response is the *valid-signature* branch, so production was verifying
 * with a public string: anyone who can read the source could mint an accepted
 * token. `.required()` did not catch it — the variable was present, its value was
 * the problem — which is why the schema now also rejects the placeholder and
 * anything shorter than `MIN_JWT_SECRET_LENGTH`.
 *
 * This harness pins three things:
 *
 *   A. the schema: what it accepts, and the wording it rejects with,
 *   B. the wiring, read from the source: `api/index.ts` calls `validate(process.env)`
 *      BEFORE it builds the app (`main.ts` keeps its call),
 *   C. the behaviour at cold start, by actually running `api/index.ts` in a child
 *      process with a scrubbed environment — a bad secret must fail the process,
 *      and the same file with a good secret must not.
 *
 * §D is the control that makes C mean something: `src/app.module` alone loads fine
 * with the bad secret, so the child's failure is attributable to the validator
 * rather than to the module graph.
 *
 * Declared in `tests/` rather than `src/`, so it is compiled by
 * `tsconfig.tests.json` and never shipped.
 *
 * Exits non-zero if any check fails.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    MIN_JWT_SECRET_LENGTH,
    PLACEHOLDER_JWT_SECRET,
    validate,
} from '../src/config/env.validation';

const SRC_DIR = join(__dirname, '..', 'src');
const API_ENTRYPOINT = join(__dirname, '..', 'api', 'index.ts');
const MAIN_FILE = join(SRC_DIR, 'main.ts');
const ENV_EXAMPLE_FILE = join(__dirname, '..', '.env.example');

const failures: string[] = [];

const check = (label: string, condition: boolean, detail?: string): void => {
    if (condition) {
        console.log(`  OK   ${label}`);
        return;
    }

    const suffix = detail ? ` — ${detail}` : '';
    console.log(`  FAIL ${label}${suffix}`);
    failures.push(`${label}${suffix}`);
};

const section = (title: string): void => {
    console.log(`\n=== ${title} ===`);
};

/** Iterating a Map-free structure: a plain object, so the order is the source's. */
const VALID_CONFIG = {
    MONGODB_URI: 'mongodb+srv://user:pass@cluster.mongodb.net/db',
    JWT_SECRET: 'N4wq7lKM0sVt2pXe9bRzHcJyUaGdTfSi-LpOnEmQr',
    IMAGEKIT_URL_ENDPOINT: 'https://ik.imagekit.io/probe',
    IMAGEKIT_PUBLIC_KEY: 'probe-public-key',
    IMAGEKIT_PRIVATE_KEY: 'probe-private-key',
};

/** Runs `validate` and returns the thrown message, or null when it accepted. */
const rejectionOf = (config: Record<string, unknown>): string | null => {
    try {
        validate(config);
        return null;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
};

const readSource = (file: string): string =>
    readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => {
            const trimmed = line.trim();

            return !(
                trimmed.startsWith('//') ||
                trimmed.startsWith('/*') ||
                trimmed.startsWith('*') ||
                trimmed.startsWith('*/')
            );
        })
        .join('\n');

/**
 * Environment for the child processes.
 *
 * The ImageKit and Mongo values are inert probes: without them `app.module`'s
 * module-load construction throws before the validator is reached, which would
 * make a failure un-attributable. `JWT_SECRET` is set per call.
 */
const childEnv = (jwtSecret: string): NodeJS.ProcessEnv => ({
    ...process.env,
    MONGODB_URI: 'mongodb://127.0.0.1:27017/probe',
    IMAGEKIT_URL_ENDPOINT: 'https://ik.imagekit.io/probe',
    IMAGEKIT_PUBLIC_KEY: 'probe-public-key',
    IMAGEKIT_PRIVATE_KEY: 'probe-private-key',
    JWT_SECRET: jwtSecret,
});

const runChild = (
    args: string[],
    jwtSecret: string
): { status: number | null; stdout: string; stderr: string } => {
    const result = spawnSync(process.execPath, args, {
        cwd: join(__dirname, '..'),
        env: childEnv(jwtSecret),
        encoding: 'utf8',
        timeout: 90_000,
    });

    return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
    };
};

const main = (): void => {
    /* ── A. The schema ─────────────────────────────────────────────────── */
    section('A. What the schema accepts and what it refuses');

    check(
        'a complete configuration with a real secret is accepted',
        rejectionOf(VALID_CONFIG) === null,
        String(rejectionOf(VALID_CONFIG))
    );

    const missing = rejectionOf({ ...VALID_CONFIG, JWT_SECRET: undefined });
    check('a missing JWT_SECRET is refused', missing !== null, 'it was accepted');
    check(
        'and the message names JWT_SECRET',
        typeof missing === 'string' && missing.includes('JWT_SECRET'),
        String(missing)
    );

    const empty = rejectionOf({ ...VALID_CONFIG, JWT_SECRET: '' });
    check('an empty JWT_SECRET is refused', empty !== null);
    check(
        'and the message names JWT_SECRET',
        typeof empty === 'string' && empty.includes('JWT_SECRET'),
        String(empty)
    );

    const placeholder = rejectionOf({ ...VALID_CONFIG, JWT_SECRET: PLACEHOLDER_JWT_SECRET });
    check(
        'the placeholder secret committed in the repository is refused (the P1.6.2 rule)',
        placeholder !== null,
        'this is the value production was running with'
    );
    check(
        'and the message says why: it is public',
        typeof placeholder === 'string' && /placeholder/i.test(placeholder) && /public|committed/i.test(placeholder),
        String(placeholder)
    );
    check(
        'the placeholder really is the string the code falls back to',
        PLACEHOLDER_JWT_SECRET === 'mioralane_jwt_super_secret_change_in_production',
        PLACEHOLDER_JWT_SECRET
    );

    const short = rejectionOf({ ...VALID_CONFIG, JWT_SECRET: 'too-short' });
    check('a short JWT_SECRET is refused', short !== null);
    check(
        `and the message states the ${MIN_JWT_SECRET_LENGTH}-character floor`,
        typeof short === 'string' && short.includes(String(MIN_JWT_SECRET_LENGTH)),
        String(short)
    );
    check(
        'the floor is 32 characters, not a token value',
        MIN_JWT_SECRET_LENGTH === 32,
        String(MIN_JWT_SECRET_LENGTH)
    );

    const noMongo = rejectionOf({ ...VALID_CONFIG, MONGODB_URI: undefined });
    check(
        'a missing MONGODB_URI is still refused and named',
        typeof noMongo === 'string' && noMongo.includes('MONGODB_URI'),
        String(noMongo)
    );

    const returned = validate(VALID_CONFIG) as Record<string, unknown>;
    check(
        'the returned value carries the optional defaults (callers discard it, so it cannot be relied on)',
        returned.PORT === 3000 && returned.NODE_ENV === 'development',
        JSON.stringify({ PORT: returned.PORT, NODE_ENV: returned.NODE_ENV })
    );

    /* ── B. The wiring ─────────────────────────────────────────────────── */
    section('B. The serverless entrypoint validates too');

    const entrypoint = readSource(API_ENTRYPOINT);
    const mainFile = readSource(MAIN_FILE);

    check(
        'api/index.ts imports the validator',
        /import \{ validate \} from '\.\.\/src\/config\/env\.validation'/.test(entrypoint)
    );
    check('api/index.ts calls it', /validate\(process\.env\)/.test(entrypoint));
    check(
        'and calls it BEFORE building the app',
        entrypoint.indexOf('validate(process.env)') !== -1 &&
            entrypoint.indexOf('validate(process.env)') < entrypoint.indexOf('createApp()'),
        'a validator that runs after createApp() would not gate the boot'
    );
    check('main.ts keeps its own call', /validate\(process\.env\)/.test(mainFile));
    check(
        'api/index.ts still exports the app for Vercel',
        /export default app/.test(entrypoint)
    );

    const envExample = readFileSync(ENV_EXAMPLE_FILE, 'utf8');
    check(
        '.env.example does not ship a copyable placeholder for JWT_SECRET',
        /^JWT_SECRET=$/m.test(envExample),
        'a copy-pasteable value would pass the new checks'
    );
    check(
        'and it tells the operator how to generate one',
        /openssl rand -base64 48/.test(envExample)
    );

    /* ── C. Cold start, in a child process ─────────────────────────────── */
    section('C. Cold start: the real entrypoint, with a scrubbed environment');

    const badSecret = runChild(['--import', 'tsx', API_ENTRYPOINT], '');
    check(
        'a deployment with an empty JWT_SECRET fails to boot',
        badSecret.status !== 0,
        `exit ${badSecret.status}`
    );
    check(
        'and it fails with the config-validation error, naming the variable',
        /Config validation error/.test(badSecret.stderr) && /JWT_SECRET/.test(badSecret.stderr),
        badSecret.stderr.split('\n').filter((line) => line.includes('Config validation'))[0] ?? '(no message)'
    );

    const placeholderBoot = runChild(['--import', 'tsx', API_ENTRYPOINT], PLACEHOLDER_JWT_SECRET);
    check(
        'a deployment still on the placeholder secret fails to boot too',
        placeholderBoot.status !== 0,
        `exit ${placeholderBoot.status}`
    );
    check(
        'and says the value is a placeholder rather than a length problem',
        /placeholder/i.test(placeholderBoot.stderr),
        placeholderBoot.stderr.split('\n').filter((line) => line.includes('JWT_SECRET'))[0] ?? '(no message)'
    );

    const goodSecret = runChild(['--import', 'tsx', API_ENTRYPOINT], VALID_CONFIG.JWT_SECRET);
    check(
        'the same file boots cleanly with a real secret (so the failures above are the secret, not the file)',
        goodSecret.status === 0,
        `exit ${goodSecret.status} ${goodSecret.stderr.split('\n')[0] ?? ''}`
    );

    /* ── D. Control ────────────────────────────────────────────────────── */
    section('D. Control: the module graph alone does not reject the bad secret');

    const moduleOnly = runChild(
        [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            'await import("./src/app.module"); console.log("APP MODULE LOADED OK");',
        ],
        ''
    );

    check(
        'control: app.module loads fine with an EMPTY secret',
        moduleOnly.status === 0 && /APP MODULE LOADED OK/.test(moduleOnly.stdout),
        `exit ${moduleOnly.status} ${moduleOnly.stderr.split('\n')[0] ?? ''}`
    );
    check(
        'control: so section C is measuring the validator, not the import graph',
        moduleOnly.status === 0 && badSecret.status !== 0,
        `module-only ${moduleOnly.status} vs entrypoint ${badSecret.status}`
    );

    /* ── Result ────────────────────────────────────────────────────────── */
    console.log('\n=== Result ===');

    if (failures.length > 0) {
        console.log(`FAILED (${failures.length}):`);
        for (const failure of failures) {
            console.log(`  - ${failure}`);
        }

        process.exitCode = 1;
        return;
    }

    console.log('The environment contract holds at every entrypoint.');
};

void main();
