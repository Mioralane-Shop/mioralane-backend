import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { connectDB } from './data-source';
import authRoutes from './auth/auth.routes';
import productRoutes from './product/product.routes';
import comboRoutes from './combo/combo.routes';
import orderRoutes from './order/order.routes';
import adminOrderRoutes from './order/admin-order.routes';
import adminCustomerRoutes from './customer/admin-customer.routes';
import adminDashboardRoutes from './dashboard/admin-dashboard.routes';
import mediaRoutes from './media/media.routes';
import imageKitRoutes from './imagekit/imagekit.module';
import wishlistRoutes from './wishlist/wishlist.routes';
import addressRoutes from './address/address.routes';
import {
  adminCampaignRoutes,
  adminCouponRoutes,
  promotionPublicRoutes,
} from './promotion/promotion.routes';
import { adminShippingSettingsRoutes, shippingRoutes } from './shipping/shipping.routes';
import { adminInventorySettingsRoutes, adminInventoryRoutes } from './inventory/inventory.routes';
import { activityLogRoutes } from './activity-log/activity-log.routes';
import { adminCrossSellSettingsRoutes } from './cross-sell/cross-sell.routes';
import {
  adminAnnouncementRoutes,
  announcementPublicRoutes,
} from './announcement/announcement.routes';
import { adminMegaMenuRoutes, megaMenuPublicRoutes } from './mega-menu/mega-menu.routes';
import { adminBrandRoutes, brandPublicRoutes } from './brand/brand.routes';
import reviewRoutes from './review/review.routes';
import adminReviewRoutes from './review/admin-review.routes';
import helmet from 'helmet';
import {
  authLimiter,
  createGlobalLimiter,
  createWriteLimiter,
  readRateLimitSettings,
  turnstileLimiter,
} from './middleware/rateLimiter.middleware';
import { csrfOriginGuard } from './middleware/csrf.middleware';
import { CSRF_HEADER, csrfTokenGuard } from './middleware/csrf-token.middleware';
import { TURNSTILE_TOKEN_HEADER } from './turnstile/turnstile.middleware';
import { stripMongoOperators } from './middleware/strip-mongo-operators.middleware';
import {
  CorsOriginDeniedError,
  errorHandler,
  notFoundHandler,
  requestId,
} from './middleware/error.middleware';
import { getAllowedOrigins } from './config/allowed-origins';
import { readTrustProxyHops } from './config/trust-proxy';
import {
  createApiDocsHandlers,
  handleOpenApiJson,
} from './swagger';
import { turnstileRoutes } from './turnstile/turnstile.routes';

/**
 * Options for {@link createApp}.
 *
 * `skipDatabaseCheck` is a TEST SEAM and nothing else: with it set, the
 * guard-then-connect middleware is not mounted, so the real middleware chain can
 * be exercised without a live MongoDB. It is deliberately not read from env, so
 * it cannot be switched on by configuration in a deployed environment, and
 * `tests/verify-security-headers.ts` asserts statically that neither entrypoint
 * passes it. It removes a connection attempt — never authentication, validation
 * or any other control.
 */
export type CreateAppOptions = {
  skipDatabaseCheck?: boolean;
};

const createApp = (options: CreateAppOptions = {}): express.Application => {
  const app = express();

  // ── Proxy trust ───────────────────────────────────────────────────────────
  // MUST be set before any middleware reads `req.ip`. Behind Cloudflare →
  // Vercel the TCP peer is a proxy, so without this every caller shares one
  // address: `authLimiter` becomes a single bucket (one attacker locks out all
  // logins) and the audit log records the proxy. See config/trust-proxy.ts.
  app.set('trust proxy', readTrustProxyHops());

  // Correlation id — mounted before everything else, including CORS, so that a
  // request rejected at the very first middleware still carries one. The id is
  // echoed as `X-Request-Id` on every response and printed with every 5xx log
  // line, which is what ties a user-visible failure to its stack trace.
  app.use(requestId);

  // ── Security headers ─────────────────────────────────────────────────────
  // Ahead of CORS on purpose: a request rejected by the CORS callback still
  // passes through here first, so even that 403 carries the headers.
  app.use(
    helmet({
      // The API returns JSON, never HTML documents, so a CSP would protect
      // nothing here — and would break the Swagger UI in development.
      contentSecurityPolicy: false,
      // Cloudflare terminates TLS (Full) and Vercel serves HTTPS, so pinning
      // browsers to HTTPS is safe. No `preload`: it is close to irreversible.
      hsts: { maxAge: 31536000, includeSubDomains: true },
      // Stops a browser from re-interpreting a JSON body as script.
      noSniff: true,
      // An API response is never legitimate frame content.
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'no-referrer' },
      // Product and combo images are served from ImageKit, a different origin.
      // The helmet default (`same-origin`) would make browsers refuse them.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // Drops `X-Powered-By: Express`, which advertises the stack.
      hidePoweredBy: true,
    })
  );

  // Middlewares — CORS must be first.
  // The origin allowlist lives in `config/allowed-origins.ts` so CORS and the
  // CSRF guard below can never disagree about which origins are trusted. That
  // module reads the optional `CORS_ORIGINS` env override, so a staging domain
  // can be trusted without a code change.
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) {
          callback(null, true);
          return;
        }

        if (getAllowedOrigins().includes(origin)) {
          callback(null, true);
        } else {
          // Rejected origins are forwarded to the terminal error handler, which
          // answers 403 `{ success: false, message: 'Origin not allowed' }`. The
          // rejected origin travels as a property, not in the message, so it
          // reaches the server log and never the response body. Previously this
          // carried the origin in the message and fell through to Express's
          // default handler, which answered 500 with an HTML body.
          callback(new CorsOriginDeniedError(origin));
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      // `CSRF_HEADER` and `TURNSTILE_TOKEN_HEADER` must be here or the browser's
      // preflight refuses every state-changing request before it is even sent —
      // a failure that looks nothing like a CSRF or Turnstile error. Both are
      // imported rather than spelled out so the browser contract cannot drift
      // from the headers the guards read.
      allowedHeaders: ['Content-Type', 'Authorization', CSRF_HEADER, TURNSTILE_TOKEN_HEADER],
      // Let the browser reuse a preflight result for a day instead of sending
      // one before every write. Without this, a preflight per request would
      // double the traffic the write limiter does not charge for.
      maxAge: 86400,
    })
  );

  app.use(express.json());

  // Defence-in-depth against NoSQL operator injection: drop `$`-prefixed and
  // dotted keys from user input before any route (or the DB middleware) sees it.
  // The Zod schemas on individual routes are the primary control.
  app.use(stripMongoOperators);

  app.use(cookieParser());

  // Reject cross-site state-changing requests before they reach the DB
  // middleware or any route handler.
  //
  // Two independent controls, in this order and both mandatory:
  //   1. `csrfOriginGuard`  — the caller's Origin/Referer must be allowlisted.
  //   2. `csrfTokenGuard`   — a request carrying a session must also prove it
  //      holds the HMAC token for that session.
  // Neither replaces the other: (1) fails open when a client omits both
  // headers, which is exactly the gap (2) closes. See the module headers for
  // why the token cannot be a classic double-submit cookie here.
  app.use(csrfOriginGuard);
  app.use(csrfTokenGuard);

  // ── Rate limits ──────────────────────────────────────────────────────────
  // After the cheap guards (body parse, operator stripping, CSRF) and before
  // the DB middleware, so a flood is refused without a connection attempt and
  // without touching MongoDB. Limits are env-tunable; see
  // middleware/rateLimiter.middleware.ts for the defaults and the keying note.
  const rateLimitSettings = readRateLimitSettings();

  app.use(createGlobalLimiter(rateLimitSettings));
  app.use(createWriteLimiter(rateLimitSettings));

  // ── DB middleware: ensure MongoDB is connected before any route handler ──
  // On Vercel serverless, the first "cold start" triggers the connection;
  // subsequent "warm" invocations hit the cached promise from data-source.ts.
  //
  // Not mounted when `skipDatabaseCheck` is set — a test seam only, see
  // {@link CreateAppOptions}.
  if (!options.skipDatabaseCheck) {
    app.use(async (_req, _res, next) => {
      try {
        await connectDB();
        next();
      } catch (err) {
        console.error('❌ DB connection failed:', err);
        _res.status(503).json({ success: false, message: 'Database unavailable — try again shortly' });
      }
    });
  }

  // ── API docs (development only) ──────────────────────────────────────────
  // In production these mounts are skipped entirely, so /api/docs and
  // /api/docs-json fall through to the terminal 404 handler — an attacker
  // enumerating the API surface gets the same answer as for any unknown path.
  const apiDocsHandlers = createApiDocsHandlers();

  if (apiDocsHandlers.length > 0) {
    app.use('/api/docs', ...apiDocsHandlers);
    app.get('/api/docs-json', handleOpenApiJson);
  }

  // Root API health check
  app.get('/api', (_req, res) => {
    res.json({ message: 'Mioralane API is running', timestamp: new Date().toISOString() });
  });

  // Routes — auth rate-limited
  app.use('/api/auth', authLimiter, authRoutes);

  // Product routes (public + admin)
  app.use('/api/products', productRoutes);

  // Combo / bundle routes (public + admin)
  app.use('/api/combos', comboRoutes);

  // Order routes (authenticated user flow)
  app.use('/api/orders', orderRoutes);

  // Admin order management
  app.use('/api/admin/orders', adminOrderRoutes);

  // Admin customer management
  app.use('/api/admin/customers', adminCustomerRoutes);

  // Admin dashboard summary
  app.use('/api/admin/dashboard', adminDashboardRoutes);

  // Promotion campaign and coupon management
  app.use('/api/admin/campaigns', adminCampaignRoutes);
  app.use('/api/admin/coupons', adminCouponRoutes);
  app.use('/api/admin/settings', adminShippingSettingsRoutes);
  app.use('/api/admin/settings', adminInventorySettingsRoutes);

  // Inventory ledger + manual stock operations
  app.use('/api/admin/inventory', adminInventoryRoutes);
  app.use('/api/admin/settings', adminCrossSellSettingsRoutes);

  // Audit trail (admin-only)
  app.use('/api/activity-logs', activityLogRoutes);
  app.use('/api/promotions', promotionPublicRoutes);

  // Storefront announcement bar (top ticker) — managed from its own admin menu
  app.use('/api/admin/announcement', adminAnnouncementRoutes);
  app.use('/api/announcements', announcementPublicRoutes);

  // Storefront "Shop" mega menu (desktop navbar panel) — curation-only singleton
  app.use('/api/admin/mega-menu', adminMegaMenuRoutes);
  app.use('/api/mega-menu', megaMenuPublicRoutes);

  // Storefront brands — CRUD, one document per brand, curated from the admin app
  app.use('/api/admin/brands', adminBrandRoutes);
  app.use('/api/brands', brandPublicRoutes);
  app.use('/api/shipping', shippingRoutes);

  // Wishlist routes (authenticated user flow)
  app.use('/api/wishlist', wishlistRoutes);

  // Saved delivery addresses (authenticated user flow)
  app.use('/api/addresses', addressRoutes);

  // Reviews (public product reviews + authenticated customer submission/history)
  app.use('/api/reviews', reviewRoutes);

  // Review moderation (admin only)
  app.use('/api/admin/reviews', adminReviewRoutes);

  // Cloudflare Turnstile verification (public) — rate-limited bot protection for
  // the login/register/checkout flows. Public on purpose: it is reached before a
  // caller holds any session, and it stores nothing of its own.
  app.use('/api/verify-turnstile', turnstileLimiter, turnstileRoutes);

  // Real reusable media upload/delete routes for product and combo assets
  app.use('/api/media', mediaRoutes);

  // Temporary development-only ImageKit upload test route
  if (process.env.NODE_ENV !== 'production') {
    // Deprecated dev-only smoke test route retained for backward verification.
    app.use('/api/imagekit', imageKitRoutes);
  }

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── Terminal middleware ──────────────────────────────────────────────────
  // Order is load-bearing. `notFoundHandler` and `errorHandler` must be the last
  // two registrations, after every route: Express walks middleware in
  // registration order, so anything mounted after these would be unreachable.
  // An unmatched path falls to the 404 handler; a thrown or rejected error from
  // any earlier middleware or handler skips straight to the four-argument error
  // handler.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

export default createApp;

