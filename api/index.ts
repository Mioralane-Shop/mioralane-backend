import '../src/env';
import { connectDB } from '../src/data-source';
import createApp from '../src/app.module';

const app = createApp();

// ── DB middleware: ensure MongoDB is connected before any route handler ──
// On Vercel serverless, the first "cold start" invocation triggers the
// connection; subsequent "warm" invocations hit the cached promise.
app.use(async (_req, _res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('❌ DB connection failed for incoming request:', err);
    _res.status(503).json({ success: false, message: 'Database unavailable — try again shortly' });
  }
});

/**
 * Vercel serverless handler.
 * Exports the Express application as the default export so Vercel can
 * serve all routes through a single serverless function.
 */
export default app;
