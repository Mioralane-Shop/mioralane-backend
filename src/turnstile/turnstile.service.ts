/**
 * Cloudflare Turnstile — server-side token verification.
 *
 * A Turnstile token proves nothing until it is exchanged at Cloudflare's
 * Siteverify endpoint: the hidden widget runs in the visitor's browser, so a
 * script can call the challenge directly and hand back whatever it likes. This
 * module performs that exchange and returns a verdict.
 *
 * It is deliberately dependency-free — native `fetch` (Node >= 18, which both
 * entrypoints already require) rather than the Cloudflare SDK — so a
 * bot-protection control cannot itself become a supply-chain or bundle-size
 * liability in the API.
 *
 * Failure policy, and why it is shaped this way:
 *   - **No secret configured** → `{ success: false, reason: 'disabled' }` plus a
 *     single warning. The endpoint stays reachable, and a local or preview
 *     deployment is not blocked by a missing key. Production is expected to set
 *     `TURNSTILE_SECRET_KEY`.
 *   - **Every other failure** (timeout, transport error, non-2xx,
 *     `success: false`) → `{ success: false, reason }`. The function NEVER throws
 *     and never returns a bare boolean, so a caller cannot mistake a transport
 *     failure for a pass.
 *
 * The token and the secret are never logged, never echoed to a client, and never
 * placed in a returned `reason`.
 */

/** Cloudflare's verification endpoint — part of Cloudflare's public contract. */
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Cloudflare answers well inside this; the ceiling stops a hung socket holding a request open. */
export const TURNSTILE_TIMEOUT_MS = 5000;

/** The subset of Cloudflare's response this module reads. */
type SiteverifyResponse = {
    success?: boolean;
    'error-codes'?: string[];
};

export type TurnstileVerification = {
    success: boolean;
    /**
     * Machine-readable outcome, present whenever `success` is false. Values are
     * stable and non-sensitive: `disabled`, `timeout`, `network_error`,
     * `http_<status>`, `verification_failed`, or a Cloudflare code such as
     * `invalid-input-response`.
     */
    reason?: string;
};

/**
 * Exchanges a Turnstile token for a verdict.
 *
 * `token` must be the `cf-turnstile-response` value produced by the widget. All
 * failures are normalised into the returned object, so callers have exactly one
 * shape to handle.
 */
export const verifyTurnstile = async (token: string): Promise<TurnstileVerification> => {
    const secret = process.env.TURNSTILE_SECRET_KEY;

    if (secret === undefined || secret.trim() === '') {
        console.warn(
            '[turnstile] TURNSTILE_SECRET_KEY is not set — bot-protection verification is disabled'
        );

        return { success: false, reason: 'disabled' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TURNSTILE_TIMEOUT_MS);

    try {
        const response = await fetch(SITEVERIFY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Never logged: this body carries the secret and the token.
            body: JSON.stringify({ secret, response: token }),
            signal: controller.signal,
        });

        if (!response.ok) {
            return { success: false, reason: `http_${response.status}` };
        }

        const payload = (await response.json()) as SiteverifyResponse;

        if (payload.success === true) {
            return { success: true };
        }

        return {
            success: false,
            reason: payload['error-codes']?.[0] ?? 'verification_failed',
        };
    } catch (error) {
        const aborted =
            typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';

        return { success: false, reason: aborted ? 'timeout' : 'network_error' };
    } finally {
        clearTimeout(timeout);
    }
};
