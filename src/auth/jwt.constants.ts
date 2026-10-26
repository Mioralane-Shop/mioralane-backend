/**
 * JWT contract shared by the signer and every verifier.
 *
 * The customer and admin token families share the signing secret but NOT the
 * audience: a customer token is minted for `mioralane-clients` and an admin
 * token for `mioralane-admin-clients`. `jwt.verify` pins the audience, so a
 * token from one family cannot be presented to the other's guard even when both
 * are signed with the same key. That is the structural half of the
 * customer/admin isolation (the other half is the separate cookie and the
 * database-backed admin session).
 */
export const JWT_ALGORITHM = 'HS256' as const;
export const JWT_ISSUER = 'mioralane-api';
export const JWT_AUDIENCE = 'mioralane-clients';
export const ADMIN_JWT_AUDIENCE = 'mioralane-admin-clients';

/** Cookie carrying a customer session. Unchanged from the original design. */
export const CUSTOMER_TOKEN_COOKIE = 'token';

/**
 * Cookie carrying an admin session.
 *
 * A different name is what allows a browser to hold both sessions at once (the
 * same API host owns the cookies for the storefront and the admin panel) without
 * either one displacing or impersonating the other.
 */
export const ADMIN_TOKEN_COOKIE = 'admin_token';
