import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRoutes from './auth/auth.routes';
import { authLimiter } from './middleware/rateLimiter.middleware';

const createApp = (): express.Application => {
  const app = express();

  // Middlewares
  app.use(
    cors({
      origin: process.env.CLIENT_URL || 'http://localhost:3000',
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );

  app.use(express.json());
  app.use(cookieParser());

  // Routes — auth rate-limited
  app.use('/api/auth', authLimiter, authRoutes);

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return app;
};

export default createApp;

