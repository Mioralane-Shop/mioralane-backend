import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { connectDB } from './data-source';
import authRoutes from './auth/auth.routes';
import productRoutes from './product/product.routes';
import { authLimiter } from './middleware/rateLimiter.middleware';
import { swaggerSpec, swaggerServe, swaggerSetup } from './swagger';

const createApp = (): express.Application => {
  const app = express();

  // Middlewares — CORS must be first
  app.use(
    cors({
      origin: [
        'https://mioralane.com',
        'https://www.mioralane.com',
        'http://localhost:3000',
      ],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );

  app.use(express.json());
  app.use(cookieParser());

  // ── DB middleware: ensure MongoDB is connected before any route handler ──
  // On Vercel serverless, the first "cold start" triggers the connection;
  // subsequent "warm" invocations hit the cached promise from data-source.ts.
  app.use(async (_req, _res, next) => {
    try {
      await connectDB();
      next();
    } catch (err) {
      console.error('❌ DB connection failed:', err);
      _res.status(503).json({ success: false, message: 'Database unavailable — try again shortly' });
    }
  });

  // Swagger UI — interactive API docs (mounted on /api/docs to avoid
  // conflicting with /api/products, /api/auth, etc.)
  app.use('/api/docs', swaggerServe, swaggerSetup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Mioralane API Docs',
  }));

  // Serve raw OpenAPI JSON
  app.get('/api/docs-json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(swaggerSpec);
  });

  // Root API health check
  app.get('/api', (_req, res) => {
    res.json({ message: 'Mioralane API is running', timestamp: new Date().toISOString() });
  });

  // Routes — auth rate-limited
  app.use('/api/auth', authLimiter, authRoutes);

  // Product routes (public + admin)
  app.use('/api/products', productRoutes);

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return app;
};

export default createApp;

