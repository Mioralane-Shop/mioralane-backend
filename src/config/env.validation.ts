import * as Joi from 'joi';

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
    JWT_SECRET: Joi.string().required(),
    JWT_EXPIRES_IN: Joi.string().default('7d'),
    // Admin sessions are deliberately shorter-lived than customer sessions.
    // Optional: a default is applied, so no deployment change is required.
    ADMIN_JWT_EXPIRES_IN: Joi.string().default('1h'),
    IMAGEKIT_URL_ENDPOINT: Joi.string().uri().required(),
    IMAGEKIT_PUBLIC_KEY: Joi.string().required(),
    IMAGEKIT_PRIVATE_KEY: Joi.string().required(),
    // ── P0-5 security tuning ──────────────────────────────────────────────
    // Optional, and documented rather than enforced here. Two reasons:
    //   1. `validate()` is called only by `src/main.ts`, and its return value is
    //      discarded, so a Joi `.default()` would never reach anything.
    //   2. `api/index.ts` — the entrypoint production actually runs — does not
    //      call this at all.
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
