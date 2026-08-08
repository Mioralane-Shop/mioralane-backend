import swaggerJsdoc from 'swagger-jsdoc';
import { serve, setup } from 'swagger-ui-express';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Mioralane API',
      version: '1.0.0',
      description: 'REST API for Mioralane — premium Korean skincare e-commerce',
      contact: {
        name: 'Mioralane',
        url: 'https://mioralane.com',
      },
    },
    servers: [
      {
        url: 'http://localhost:5000',
        description: 'Development server',
      },
      {
        url: 'https://mioralane-backend.vercel.app',
        description: 'Production (Vercel)',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter your JWT token from POST /api/auth/login',
        },
      },
    },
    security: [], // No global security — applied per-route
  },
  apis: [
    './src/auth/auth.controller.ts',
    './src/auth/auth.routes.ts',
    './src/product/product.controller.ts',
  ],
};

export const swaggerSpec = swaggerJsdoc(options);

export { serve as swaggerServe, setup as swaggerSetup };
