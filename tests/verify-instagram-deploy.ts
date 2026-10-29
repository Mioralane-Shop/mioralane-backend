/**
 * Deploy gate — are the Instagram routes actually serving on the target host?
 *
 * Run with: npm run verify:instagram-deploy [baseUrl]
 *
 * Why this exists: `dist/` is gitignored on the OVH VPS, so a `git pull` without
 * `npm run build` + restart leaves the previous build serving. The module was
 * merged into `production` and still answered 404 for months, because nothing
 * checked the DEPLOYED surface — only the source. Every other harness in this
 * directory inspects source or a child process; this one is deliberately the
 * only one that talks to a running server.
 *
 * The distinction that matters is 404 vs 401:
 *
 *   404 -> the router is not mounted, i.e. the build predates the module.
 *   401 -> the router IS mounted and `adminGuard` refused an anonymous caller.
 *
 * So the admin routes are asserted to be UNAUTHORIZED, not forbidden and not
 * missing; a 200 here would mean the guard had stopped working, which is a worse
 * bug than the one this replaces. The public feed is asserted to exist and, when
 * it answers 200, to carry the `{ success, videos }` contract the storefront
 * reads.
 *
 * No credentials are used or needed: every admin call is expected to be refused.
 *
 * Declared in `tests/` rather than `src/`, so it is compiled by
 * `tsconfig.tests.json` and never shipped. It is NOT part of the CI workflow —
 * CI has no network dependency and no live host to point at.
 *
 * Exits non-zero if any check fails.
 */

const DEFAULT_BASE_URL = 'https://api.mioralane.com';
const TIMEOUT_MS = 15000;

const baseUrl = (process.argv[2] ?? process.env.INSTAGRAM_CHECK_BASE_URL ?? DEFAULT_BASE_URL).replace(
  /\/+$/,
  ''
);

const failures: string[] = [];

const check = (label: string, condition: boolean, detail: string): void => {
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${condition ? '' : ` — ${detail}`}`);
  if (!condition) {
    failures.push(`${label}: ${detail}`);
  }
};

type Probe = {
  status: number;
  body: unknown;
  error?: string;
};

const probe = async (method: string, path: string): Promise<Probe> => {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    return { status: response.status, body };
  } catch (error) {
    return { status: 0, body: null, error: error instanceof Error ? error.message : String(error) };
  }
};

const describe = (probeResult: Probe): string => {
  if (probeResult.status === 0) {
    return `request failed (${probeResult.error ?? 'unknown error'})`;
  }

  const body = probeResult.body as { message?: unknown; code?: unknown } | null;
  const message = typeof body?.message === 'string' ? body.message : '';
  const code = typeof body?.code === 'string' ? body.code : '';

  return `${probeResult.status} ${code || message}`.trim();
};

const run = async (): Promise<void> => {
  console.log(`\nInstagram route contract against ${baseUrl}\n`);

  // ── Storefront feed: public, mounted at /api/instagram/feed ───────────────
  const feed = await probe('GET', '/api/instagram/feed');

  check(
    'GET /api/instagram/feed is routed (not 404)',
    feed.status !== 404,
    `got 404 — the deployed build does not mount instagramPublicRoutes; rebuild and restart the API`
  );

  if (feed.status === 200) {
    const body = feed.body as { success?: unknown; videos?: unknown } | null;
    check(
      'GET /api/instagram/feed returns { success: true, videos: [] }',
      body?.success === true && Array.isArray(body.videos),
      `unexpected payload shape: ${JSON.stringify(body)?.slice(0, 120) ?? 'null'}`
    );
    if (Array.isArray(body?.videos)) {
      console.log(
        `  info  storefront feed currently exposes ${body.videos.length} reel(s) — ` +
          `an empty array is a valid "no selection saved yet", not a routing failure`
      );
    }
  } else if (feed.status !== 0) {
    check('GET /api/instagram/feed succeeds', false, `got ${describe(feed)}`);
  }

  // ── Admin routes: mounted AND guarded ─────────────────────────────────────
  // 401 proves both properties at once: the router answered at all, and
  // adminGuard refused an anonymous caller. 200/403 would be regressions.
  const adminProbes: ReadonlyArray<{ method: string; path: string; label: string }> = [
    { method: 'GET', path: '/api/admin/instagram', label: 'admin feed' },
    { method: 'POST', path: '/api/admin/instagram/sync', label: 'admin sync' },
    { method: 'PUT', path: '/api/admin/instagram/selection', label: 'admin selection' },
  ];

  for (const { method, path, label } of adminProbes) {
    const result = await probe(method, path);

    check(
      `${method} ${path} (${label}) is routed (not 404)`,
      result.status !== 404,
      `got 404 — adminInstagramRoutes is not mounted in the deployed build`
    );

    check(
      `${method} ${path} (${label}) requires an admin session`,
      result.status === 401,
      `expected 401 for an anonymous caller, got ${describe(result)}`
    );
  }

  console.log('');

  if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed.\n`);
    process.exit(1);
  }

  console.log('All Instagram deploy checks passed.\n');
};

void run();
