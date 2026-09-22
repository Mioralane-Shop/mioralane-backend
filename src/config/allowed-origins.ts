/**
 * Single source of truth for the origins allowed to call the API with
 * credentials.
 *
 * Consumed by:
 *   - the CORS configuration in `app.module.ts`
 *   - the CSRF origin guard in `middleware/csrf.middleware.ts`
 *
 * Keeping both consumers on one list means a newly trusted origin can never be
 * accepted by CORS while being rejected by the CSRF guard (or vice versa).
 *
 * NO wildcards. `credentials: true` plus a wildcard origin would let any
 * host — including arbitrary third-party preview deployments — read
 * authenticated responses. Preview/staging environments must be added as
 * explicit hostnames.
 */

const PRODUCTION_ORIGINS: readonly string[] = [
    'https://mioralane.com',
    'https://www.mioralane.com',
    'https://admin.mioralane.com',
];

/** Local development servers: storefront (3000) and admin app (3001/3100). */
const LOCAL_ORIGINS: readonly string[] = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3100',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:3100',
];

export const getAllowedOrigins = (): string[] => [...PRODUCTION_ORIGINS, ...LOCAL_ORIGINS];

export const isAllowedOrigin = (origin: string): boolean =>
    getAllowedOrigins().includes(origin);
