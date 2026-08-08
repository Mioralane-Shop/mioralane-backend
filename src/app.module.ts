import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRoutes from './auth/auth.routes';
import productRoutes from './product/product.routes';
import { authLimiter } from './middleware/rateLimiter.middleware';
import { swaggerSpec, swaggerServe, swaggerSetup } from './swagger';

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

  // Swagger UI — interactive API docs
  app.use('/api', swaggerServe, swaggerSetup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Mioralane API Docs',
  }));

  // Serve raw OpenAPI JSON
  app.get('/api-json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(swaggerSpec);
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

