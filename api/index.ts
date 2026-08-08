import '../src/env';
import { connectDB } from '../src/data-source';
import createApp from '../src/app.module';

// Warm MongoDB connection at module load (Vercel reuses across invocations)
let dbPromise: Promise<void> | null = null;

const ensureDB = (): Promise<void> => {
  if (!dbPromise) {
    console.log('⏳ Connecting to MongoDB (Vercel cold start)...');
    dbPromise = connectDB().then(() => {
      console.log('✅ MongoDB connected (Vercel)');
    });
  }
  return dbPromise;
};

// Fire connection eagerly so it's ready for the first request
ensureDB();

const app = createApp();

/**
 * Vercel serverless handler.
 * Exports the Express application as the default export so Vercel can
 * serve all routes through a single serverless function.
 */
export default app;
