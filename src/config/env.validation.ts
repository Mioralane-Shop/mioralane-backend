import * as Joi from 'joi';

/**
 * The secret the code falls back to when `JWT_SECRET` is unset, and the value the
 * development `.env` shipped with (P1.6.2).
 *
 * It is *public* — it is in this repository — so a deployment that uses it accepts
 * any token an attacker can mint from source. Exported so the validator can refuse
 * it and so a harness can assert the refusal by name rather than by copy-paste.
 */
export const PLACEHOLDER_JWT_SECRET = 'mioralane_jwt_super_secret_change_in_production';

/** HS256 wants at least 32 bytes of entropy; 32 characters is the floor we enforce. */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Environment variable validation schema.
 * Throws an error at startup if required variables are missing or invalid.
 */
export const validate = (config: Record<string, unknown>) => {
  const schema = Joi.object({
    PORT: Joi.number().default(3000),
    NODE_ENV: Joi.string()
      .valid('development', 'production', 'test')
      .default('development'),
    MONGODB_URI: Joi.string().uri().required(),
    /*
     * P1.6.2 — `.required()` alone was not enough. Production ran with the
     * placeholder value above (proven by minting a token with it and watching the
     * API verify the signature), so "present" and "safe" had to be separated:
     * a secret that is public, or short enough to brute-force, is a deployment
     * that must not boot. The messages are written for whoever is looking at a
     * failed deploy, not for a validator.
     */
    JWT_SECRET: Joi.string()
      .min(MIN_JWT_SECRET_LENGTH)
      .invalid(PLACEHOLDER_JWT_SECRET)
      .required()
      .messages({
        'any.invalid':
          'JWT_SECRET is the placeholder value committed in this repository, so it is public. Generate a real one (openssl rand -base64 48) and set it in the deployment environment.',
        'string.min': `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters.`,
      }),
    JWT_EXPIRES_IN: Joi.string().default('7d'),
    // Admin sessions are deliberately shorter-lived than customer sessions.
    // Optional: a default is applied, so no deployment change is required.
    ADMIN_JWT_EXPIRES_IN: Joi.string().default('1h'),
    IMAGEKIT_URL_ENDPOINT: Joi.string().uri().required(),
    IMAGEKIT_PUBLIC_KEY: Joi.string().required(),
    IMAGEKIT_PRIVATE_KEY: Joi.string().required(),
    // ── P0-5 security tuning ──────────────────────────────────────────────
    // Optional, and documented rather than enforced here: the return value of
    // `validate()` is discarded by both callers, so a Joi `.default()` would never
    // reach anything.
    // (P1.6.2: `api/index.ts` — the entrypoint production actually runs — used to
    // skip this call entirely; it no longer does. The comment is kept because the
    // reason for leaving these optional is unchanged.)
    // The defaults therefore live with the readers that use them
    // (`config/allowed-origins.ts`, `config/trust-proxy.ts`,
    // `middleware/rateLimiter.middleware.ts`), which also makes them effective on
    // the serverless path. These entries exist so an operator reading the schema
    // sees the knobs and their bounds.
    CORS_ORIGINS: Joi.string().optional(),
    TRUST_PROXY_HOPS: Joi.number().integer().min(0).max(3).optional(),
    RATE_LIMIT_WINDOW_MS: Joi.number().integer().min(1000).optional(),
    RATE_LIMIT_GLOBAL_MAX: Joi.number().integer().min(1).optional(),
    RATE_LIMIT_WRITE_MAX: Joi.number().integer().min(1).optional(),
  });

  const { error, value } = schema.validate(config, { allowUnknown: true });

  if (error) {
    throw new Error(`Config validation error: ${error.message}`);
  }

  return value;
};
