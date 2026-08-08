import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI;

// Cache the connection promise so multiple Vercel invocations reuse the same connection
let cachedPromise: Promise<typeof mongoose> | null = null;

/**
 * Returns a cached MongoDB connection via Mongoose.
 * On Vercel serverless, subsequent "warm" invocations reuse the cached promise
 * so we don't open a new connection on every request.
 */
export const connectDB = async (): Promise<typeof mongoose> => {
  // Already connected — return immediately
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  // Connection in progress — wait for it
  if (cachedPromise) {
    return cachedPromise;
  }

  if (!MONGODB_URI) {
    throw new Error('❌ MONGODB_URI is not defined in environment variables.');
  }

  console.log('⏳ Connecting to MongoDB...');
  cachedPromise = mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });

  try {
    const instance = await cachedPromise;
    console.log('✅ MongoDB Connected Successfully!');
    return instance;
  } catch (error) {
    // Reset cache on failure so next invocation can retry
    cachedPromise = null;
    console.error('❌ MongoDB connection failed.');
    throw error;
  }
};

/** Returns true if Mongoose is currently connected */
export const isDBConnected = (): boolean => mongoose.connection.readyState === 1;