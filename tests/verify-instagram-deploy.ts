/**
 * Deploy gate — are the Instagram routes actually serving on the target host?
 *
 * Run with: npm run verify:instagram-deploy [baseUrl]
 *
 * Why this exists: `dist/` is gitignored on the OVH VPS, so a `git pull` without
 * `npm run build` + restart leaves the previous build serving. The module was
 * merged into `production` and the deployed site still answered 404, because
 * nothing checked the DEPLOYED surface — every other harness in this directory
 * inspects source or a child process. This is deliberately the only one that
 * talks to a running server.
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
 * A request that never completes (DNS, TLS, timeout, connection refused) has
 * `status === 0` and is reported as its OWN failure. It is emphatically NOT a
 * routing verdict: treating it as "not 404, so the route is fine" would let a
 * dead host pass the gate — the same class of silent failure this script exists
 * to catch.
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

/** Requests that never produced an HTTP response. Tracked so they cannot pass. */
let unanswered = 0;

const check = (label: string, condition: boolean, detail = ''): void => {
  const suffix = condition || !detail ? '' : ` — ${detail}`;
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${suffix}`);

  if (!condition) {
    failures.push(`${label}${detail ? `: ${detail}` : ''}`);
  }
};

type Probe = {
  /** 0 when the request never completed; there is no HTTP status to report. */
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
      // A non-JSON body (an nginx error page, say) is not a failure by itself:
      // the status still answers the routing question.
      body = null;
    }

    return { status: response.status, body };
  } catch (error) {
    return {
      status: 0,
      body: null,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
};

const describe = ({ status, body, error }: Probe): string => {
  if (status === 0) {
    return `request never completed (${error ?? 'unknown error'})`;
  }

  const payload = body as { message?: unknown; code?: unknown } | null;
  const message = typeof payload?.message === 'string' ? payload.message : '';
  const code = typeof payload?.code === 'string' ? payload.code : '';

  return `${status} ${code || message}`.trim();
};

/**
 * Records a request that never reached the server.
 *
 * Kept separate from the routing checks on purpose: the only honest conclusion
 * is "unknown", and an unknown must fail the gate rather than pass it.
 */
const failUnanswered = (label: string, result: Probe): void => {
  unanswered += 1;
  check(`${label} reached ${baseUrl}`, false, `${describe(result)} — not a routing verdict`);
};

const run = async (): Promise<void> => {
  console.log(`\nInstagram route contract against ${baseUrl}\n`);

  const adminProbes: ReadonlyArray<{ method: string; path: string; label: string }> = [
    { method: 'GET', path: '/api/admin/instagram', label: 'admin feed' },
    { method: 'POST', path: '/api/admin/instagram/sync', label: 'admin sync' },
    { method: 'PUT', path: '/api/admin/instagram/selection', label: 'admin selection' },
  ];

  const totalProbes = 1 + adminProbes.length;

  // ── Storefront feed: public, mounted at /api/instagram/feed ───────────────
  const feed = await probe('GET', '/api/instagram/feed');

  if (feed.status === 0) {
    failUnanswered('GET /api/instagram/feed', feed);
  } else if (feed.status === 404) {
    check(
      'GET /api/instagram/feed is routed',
      false,
      'got 404 — the deployed build does not mount instagramPublicRoutes; rebuild and restart the API'
    );
  } else if (feed.status === 200) {
    check('GET /api/instagram/feed is routed', true);

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
  } else {
    check('GET /api/instagram/feed is routed', false, `got ${describe(feed)}`);
  }

  // ── Admin routes: mounted AND guarded ─────────────────────────────────────
  // 401 proves both properties at once: the router answered at all, and
  // adminGuard refused an anonymous caller. 200/403 would be regressions.
  for (const { method, path, label } of adminProbes) {
    const name = `${method} ${path} (${label})`;
    const result = await probe(method, path);

    if (result.status === 0) {
      failUnanswered(name, result);
      continue;
    }

    check(
      `${name} is routed`,
      result.status !== 404,
      result.status === 404
        ? 'got 404 — adminInstagramRoutes is not mounted in the deployed build'
        : ''
    );

    // Skip the auth assertion only when there is no route to guard.
    if (result.status !== 404) {
      check(
        `${name} requires an admin session`,
        result.status === 401,
        `expected 401 for an anonymous caller, got ${describe(result)}`
      );
    }
  }

  console.log('');

  if (unanswered === totalProbes) {
    console.error(`Cannot reach ${baseUrl} — check DNS, TLS and that the API is running.\n`);
    process.exit(1);
  }

  if (unanswered > 0) {
    console.error(
      `${unanswered} of ${totalProbes} request(s) never completed — this run cannot confirm the route contract.\n`
    );
  }

  if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed.\n`);
    process.exit(1);
  }

  console.log('All Instagram deploy checks passed.\n');
};

void run();
