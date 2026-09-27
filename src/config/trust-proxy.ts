/**
 * `trust proxy` hop count.
 *
 * Why this value is security-relevant, not a deployment detail:
 *
 * The app runs behind Cloudflare in front of Vercel, so the TCP peer Express
 * sees is a proxy. Without `trust proxy`, `req.ip` is that proxy's address for
 * every caller, which breaks two things at once:
 *
 *   1. `authLimiter` counts every request into one bucket. Fifteen failed
 *      logins from one attacker therefore rate-limit *everyone* — a
 *      self-inflicted denial of service on the login form.
 *   2. `activity-log.service.ts` records the proxy as the actor's IP, so the
 *      audit trail cannot answer "which address did this".
 *
 * Express only derives the client address from `X-Forwarded-For` when it is told
 * how many proxies to trust, which is what this module supplies.
 *
 * ── Why a hop COUNT and not `true` ───────────────────────────────────────────
 * `trust proxy: true` trusts the entire `X-Forwarded-For` chain, so any client
 * could send its own header and choose the IP it is rate-limited as and logged
 * as. A count trusts exactly the hops in front of the app, and
 * `proxy-addr` then returns the rightmost address the app does not trust.
 *
 * ── Why it is env-tunable ────────────────────────────────────────────────────
 * The correct count depends on the live topology, which cannot be inferred from
 * source: Cloudflare → Vercel is one visible hop today, and Vercel adding an
 * edge hop would silently make `req.ip` report one proxy too far upstream.
 * `TRUST_PROXY_HOPS` lets that be corrected without a code change.
 *
 * The value is clamped, never taken on faith: a count high enough to reach past
 * the real proxies re-introduces the spoofing problem, so anything outside
 * 0..{@link MAX_TRUST_PROXY_HOPS} falls back to the default with a warning
 * rather than being trusted.
 */

/** Matches Cloudflare → Vercel: one proxy hop is visible to Express. */
export const DEFAULT_TRUST_PROXY_HOPS = 1;

/**
 * Upper bound for the env override.
 *
 * Three is already generous for this topology (CF → Vercel → function). The cap
 * exists so a mistyped `TRUST_PROXY_HOPS=10` cannot disable the protection it is
 * meant to configure.
 */
export const MAX_TRUST_PROXY_HOPS = 3;

/**
 * Reads `TRUST_PROXY_HOPS`, ignoring anything that is not a small non-negative
 * integer and reporting the substitution instead of failing the boot.
 *
 * A warning-and-continue is right here: refusing to start would take the API
 * down over a tuning value that has a safe default.
 */
export const readTrustProxyHops = (
    raw: string | undefined = process.env.TRUST_PROXY_HOPS
): number => {
    if (raw === undefined || raw.trim() === '') {
        return DEFAULT_TRUST_PROXY_HOPS;
    }

    const parsed = Number(raw.trim());

    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_TRUST_PROXY_HOPS) {
        console.warn(
            `[trust-proxy] TRUST_PROXY_HOPS="${raw}" is not an integer in 0..${MAX_TRUST_PROXY_HOPS}; using ${DEFAULT_TRUST_PROXY_HOPS}`
        );

        return DEFAULT_TRUST_PROXY_HOPS;
    }

    return parsed;
};
