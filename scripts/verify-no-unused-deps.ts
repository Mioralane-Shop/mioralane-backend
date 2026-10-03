/**
 * P1.7c — declared dependencies that nothing in the repository uses.
 *
 * Run with: npm run verify:unused-deps
 *
 * ## Why this exists
 *
 * P1.7 removed `passport`, `passport-jwt`, `@types/passport-jwt` and `rxjs` from
 * `package.json`. None had been imported for months: they arrived with the NestJS
 * scaffold and simply stayed behind when the code that used them was replaced. They
 * survived three separate hardening blocks, two dependency audits and a `npm audit`
 * that reported zero findings — because **an installed-but-unimported package is not a
 * vulnerability, it is just a claim**. Nothing in CI could see the difference between a
 * dependency the code needs and one that only `package.json` remembers, so nothing
 * could tell anyone to look.
 *
 * This check asks the narrow question that was missing: for every name declared in
 * `dependencies` / `devDependencies`, is there something in this repository that
 * references it?
 *
 * ## How a package is considered used
 *
 * Deliberately mechanical, because a cleverer rule is harder to trust:
 *
 *   1. **A quoted import/require** in `src/`, `api/`, `tests/` or `scripts/` — the
 *      name inside quotes followed by a quote or a `/` (so `'rxjs'` and
 *      `'rxjs/operators'` both count, as does `require('express')`).
 *   2. **A word-boundary mention in an npm script**, which covers the two ways a
 *      package is used without ever being imported: a module loaded by path
 *      (`node -r tsconfig-paths/register`, which is unquoted) and a CLI binary.
 *   3. **A binary of the package, named in an npm script** — read from the package's
 *      own `node_modules/<name>/package.json` `bin` map. This is what keeps
 *      `typescript` out of the allowlist: nothing imports it, but `build` runs `tsc`,
 *      and `tsc` is `typescript`'s binary.
 *
 * `@types/foo` is treated as used when `foo` is itself declared and used: the types
 * are ambient, so there is nothing to import. That covers every `@types` entry here
 * except `@types/node`, which is on the allowlist because it has no runtime package
 * to defer to.
 *
 * ## The allowlist is checked in both directions
 *
 * An entry needs a reason, and an entry for a package that is **no longer declared**
 * fails — otherwise the list quietly grows into a place where unused dependencies go
 * to be forgotten, which is the failure this harness exists to prevent. It is also the
 * reason this file **excludes itself** from the scan: it contains the allowlisted names
 * as quoted strings, so scanning it would let the allowlist satisfy its own check.
 *
 * ## Known limits, stated rather than implied
 *
 *   - A package named in a *comment* counts as used. That is a false negative (a real
 *     orphan could hide behind a comment), accepted because the alternative — stripping
 *     comments — also strips inline imports and makes the rule harder to reason about.
 *   - Only the four source trees are scanned. A reference from somewhere else (a
 *     Dockerfile, a shell script outside those trees) would not be seen, so an entry
 *     may need the allowlist for a reason this file cannot observe. Say so in the
 *     reason text when that happens.
 *   - It says nothing about whether a used dependency is the *right* one, or whether a
 *     version range is sensible.
 *
 * Exits non-zero if any dependency is unused without an allowlist entry, or if the
 * allowlist has gone stale.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const SOURCE_TREES = ['src', 'api', 'tests', 'scripts'];

/** This file, which cannot be scanned — see the self-reference note in the header. */
const SELF = join(ROOT, 'scripts', 'verify-no-unused-deps.ts');

/**
 * Packages that are legitimately referenced in ways this file cannot observe, each
 * with the reason. Keep it short: every entry is a decision someone has to re-make.
 */
const ALLOWLIST: ReadonlyArray<{ name: string; reason: string }> = [
    {
        name: '@types/node',
        reason: 'ambient Node globals (Buffer, process, __dirname); nothing imports it and it has no runtime package to defer to',
    },
];

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

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every `.ts` file under the source trees, minus this file. */
const collectSourceFiles = (dir: string): string[] => {
    if (!existsSync(dir)) {
        return [];
    }

    const files: string[] = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);

        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') {
                continue;
            }

            files.push(...collectSourceFiles(full));
            continue;
        }

        if (entry.name.endsWith('.ts') && full !== SELF) {
            files.push(full);
        }
    }

    return files;
};

type PackageJson = {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
};

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as PackageJson;
const scriptText = Object.values(packageJson.scripts ?? {}).join('\n');

const sourceFiles = SOURCE_TREES.flatMap((tree) => collectSourceFiles(join(ROOT, tree)));
const sourceText = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');

/** `'name'` or `'name/sub'` — the two shapes an import or require can take. */
const quotedImportPattern = (name: string): RegExp =>
    new RegExp(`['"]${escapeRegExp(name)}['"/]`);

/** A bare mention in a script command, which is how `-r tsconfig-paths/register` reads. */
const scriptMentionPattern = (name: string): RegExp =>
    new RegExp(`(^|[\\s/])${escapeRegExp(name)}([\\s/]|$)`);

/**
 * The binary names a package installs, read from its own manifest. Returns `[]` when
 * the package is not installed (an uninstalled package is still scanned for imports —
 * this only widens the "used" test, never narrows it).
 */
const readBinNames = (name: string): string[] => {
    const manifestPath = join(ROOT, 'node_modules', name, 'package.json');

    if (!existsSync(manifestPath)) {
        return [];
    }

    try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
            bin?: string | Record<string, string>;
            name?: string;
        };

        if (typeof manifest.bin === 'string') {
            return [manifest.name ?? name];
        }

        return Object.keys(manifest.bin ?? {});
    } catch {
        return [];
    }
};

type Usage = { used: boolean; how: string };

const findUsage = (name: string): Usage => {
    if (quotedImportPattern(name).test(sourceText)) {
        return { used: true, how: 'imported in src/api/tests/scripts' };
    }

    if (scriptMentionPattern(name).test(scriptText)) {
        return { used: true, how: 'named in an npm script (module loaded by path)' };
    }

    const bin = readBinNames(name).find((candidate) => scriptMentionPattern(candidate).test(scriptText));

    if (bin) {
        return { used: true, how: `npm script runs its \`${bin}\` binary` };
    }

    // `@types/foo` is ambient for `foo`: the types are pulled in by the import of `foo`.
    if (name.startsWith('@types/')) {
        const target = name.slice('@types/'.length);
        const declared =
            target in (packageJson.dependencies ?? {}) || target in (packageJson.devDependencies ?? {});

        if (declared && findUsage(target).used) {
            return { used: true, how: `ambient types for the used dependency \`${target}\`` };
        }
    }

    return { used: false, how: 'no import, script mention or binary invocation found' };
};

const allowlistReason = (name: string): string | undefined =>
    ALLOWLIST.find((entry) => entry.name === name)?.reason;

const main = (): void => {
    /* ── A. The matcher itself ─────────────────────────────────────────────── */

    section('A. The matcher can report "unused" (it is not vacuously true)');

    const synthetic = '__definitely-not-a-dependency__';
    check(
        'a name that exists nowhere is reported unused',
        findUsage(synthetic).used === false,
        findUsage(synthetic).how
    );
    check(
        'a name that IS imported is reported used',
        findUsage('express').used === true,
        findUsage('express').how
    );
    check(
        'a subpath import counts (rxjs/operators shape)',
        quotedImportPattern('rxjs').test("import { map } from 'rxjs/operators';")
    );
    check(
        'a package used only via its binary is still used',
        findUsage('typescript').used === true,
        findUsage('typescript').how
    );
    check(
        'a package loaded by path in a script is still used',
        findUsage('tsconfig-paths').used === true,
        findUsage('tsconfig-paths').how
    );
    check(
        'this file is excluded from the scan (its own allowlist would satisfy itself)',
        !sourceFiles.includes(SELF),
        `${sourceFiles.length} files scanned`
    );
    check(
        'the scan actually found source files',
        sourceFiles.length > 50,
        `${sourceFiles.length} files`
    );

    /* ── B. Every declared dependency ──────────────────────────────────────── */

    section('B. Declared dependencies and how each one is referenced');

    const declared: Array<{ name: string; group: 'dependencies' | 'devDependencies' }> = [
        ...Object.keys(packageJson.dependencies ?? {}).map(
            (name) => ({ name, group: 'dependencies' as const })
        ),
        ...Object.keys(packageJson.devDependencies ?? {}).map(
            (name) => ({ name, group: 'devDependencies' as const })
        ),
    ];

    check('there are dependencies to check', declared.length > 20, `${declared.length} declared`);

    /* ── B2. The packages that are NOT imported by name ────────────────────── */

    section('B2. Referenced without being imported (the cases a reviewer questions)');

    // These are the entries where "used" is a claim about tooling rather than about
    // source, so each one is printed with its reason instead of being folded into the
    // OK lines above. The ambient `@types/*` entries are counted rather than listed —
    // they all resolve the same way and there are ten of them.
    const nonImport = declared
        .map((entry) => ({ ...entry, usage: findUsage(entry.name) }))
        .filter((entry) => entry.usage.used && !entry.usage.how.startsWith('imported in'));

    const tooling = nonImport.filter((entry) => !entry.usage.how.startsWith('ambient types'));
    const ambient = nonImport.filter((entry) => entry.usage.how.startsWith('ambient types'));

    for (const entry of tooling) {
        check(`${entry.name} -> ${entry.usage.how}`, true);
    }

    check(
        `the remaining ${ambient.length} entries are @types satisfied by their runtime dependency`,
        ambient.every((entry) => entry.name.startsWith('@types/')),
        ambient.map((entry) => entry.name).join(', ')
    );

    for (const entry of declared) {
        const usage = findUsage(entry.name);
        const reason = allowlistReason(entry.name);

        if (usage.used) {
            check(`${entry.name} (${entry.group})`, true, usage.how);
            continue;
        }

        if (reason) {
            check(`${entry.name} — allowlisted`, true, reason);
            continue;
        }

        check(
            `${entry.name} (${entry.group}) is UNUSED`,
            false,
            'nothing imports it, no script names it and it has no invoked binary — remove it, or add an allowlist entry with a reason'
        );
    }

    /* ── C. The allowlist in the other direction ───────────────────────────── */

    section('C. The allowlist has not gone stale');

    const declaredNames = new Set(declared.map((entry) => entry.name));

    for (const entry of ALLOWLIST) {
        check(
            `allowlist entry \`${entry.name}\` still exists in package.json`,
            declaredNames.has(entry.name),
            'a stale entry is how an allowlist turns into a place unused dependencies hide'
        );
        check(
            `allowlist entry \`${entry.name}\` has a reason`,
            entry.reason.trim().length > 20,
            entry.reason
        );
    }

    check(
        'the allowlist is short enough to stay reviewable',
        ALLOWLIST.length <= 3,
        `${ALLOWLIST.length} entries — each one is a decision someone must re-make`
    );

    /* ── Result ───────────────────────────────────────────────────────────── */

    console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${failures.length} failure(s)`);

    if (failures.length > 0) {
        process.exitCode = 1;
    }
};

main();
