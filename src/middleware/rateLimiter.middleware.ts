import rateLimit from 'express-rate-limit';

/**
 * Auth-specific rate limiter.
 * Allows 15 requests per 1-minute window per IP.
 */
export const authLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 15,
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    success: false,
    message: 'Too many requests — please try again in a minute',
  },
});
