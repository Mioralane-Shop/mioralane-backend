import { Router, RequestHandler } from 'express';
import { protect, adminOnly, AuthenticatedRequest } from '../middleware/auth.middleware';
import { createCombo, getCombos, getComboByIdOrSlug, updateCombo } from './combo.controller';

const router = Router();

// Public routes
router.get('/', getCombos as RequestHandler);
router.get('/:idOrSlug', getComboByIdOrSlug as RequestHandler);

// Admin-only routes (auth temporarily disabled for dev)
router.post(
    '/',
    // protect as RequestHandler,
    // adminOnly as RequestHandler,
    createCombo as RequestHandler
);

router.put(
    '/:id',
    // protect as RequestHandler,
    // adminOnly as RequestHandler,
    updateCombo as RequestHandler
);

export default router;
