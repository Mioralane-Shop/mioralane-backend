import mongoose from 'mongoose';

let isConnected = false;

export const connectDB = async (): Promise<void> => {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.error('❌ MONGODB_URI is not defined in environment variables.');
    return;
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    isConnected = true;
    console.log('✅ MongoDB Connected Successfully!');
  } catch (error) {
    isConnected = false;
    console.error('❌ MongoDB connection failed. Server will run without database.');
    console.error('   Make sure your IP is whitelisted in MongoDB Atlas Network Access.');
  }
};

export const isDBConnected = (): boolean => isConnected;