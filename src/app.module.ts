import express from 'express';
import cors from 'cors';
import authRoutes from './auth/auth.routes';

const createApp = (): express.Application => {
  const app = express();

  // Middlewares
  app.use(
    cors({
      origin: '*', // Allow all origins for now (testing)
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );

  // Pre-flight OPTIONS requests
  app.options('*', cors());

  app.use(express.json());

  // Routes
  app.use('/api/auth', authRoutes);

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return app;
};

export default createApp;

