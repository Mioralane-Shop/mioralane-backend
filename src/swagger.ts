import type { RequestHandler } from 'express';
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
    './src/combo/combo.controller.ts',
    './src/media/media.controller.ts',
    './src/media/media.routes.ts',
  ],
};

export const swaggerSpec = swaggerJsdoc(options);

export { serve as swaggerServe, setup as swaggerSetup };

/**
 * Whether the interactive docs and the raw OpenAPI document are served.
 *
 * They are a development tool. In production they are a map of the entire API
 * surface — every admin route, every parameter name — handed to anyone who asks,
 * so they are disabled there. Gating happens at mount time (see `createApp`), so
 * a disabled docs route falls through to the terminal 404 handler and is
 * indistinguishable from any other unknown path.
 */
export const isApiDocsEnabled = (env: string | undefined = process.env.NODE_ENV): boolean =>
    env !== 'production';

/**
 * The `/api/docs` handlers, or an empty list when docs are disabled.
 *
 * Returning the handlers (rather than mounting them here) keeps the decision
 * testable: `tests/verify-security-headers.ts` calls this directly and mounts
 * the real handlers on a probe app, so the production/development assertion
 * exercises this function rather than a copy of its logic.
 */
export const createApiDocsHandlers = (
    env: string | undefined = process.env.NODE_ENV
): RequestHandler[] => {
    if (!isApiDocsEnabled(env)) {
        return [];
    }

    // `serve`/`setup` (the imported names), not the `swaggerServe`/`swaggerSetup`
    // aliases below — a re-export with `as` does not create local bindings.
    // `serve` is itself an array (static assets + the trailing-slash redirect), so
    // it is spread rather than nested.
    return [
        ...serve,
        setup(swaggerSpec, {
            customCss: '.swagger-ui .topbar { display: none }',
            customSiteTitle: 'Mioralane API Docs',
        }),
    ];
};

/** Raw OpenAPI JSON — same audience and the same gate as the UI. */
export const handleOpenApiJson: RequestHandler = (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(swaggerSpec);
};
