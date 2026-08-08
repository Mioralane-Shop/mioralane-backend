import '../src/env';
import createApp from '../src/app.module';

const app = createApp();

/**
 * Vercel serverless handler.
 * Exports the Express application as the default export so Vercel can
 * serve all routes through a single serverless function.
 */
export default app;
