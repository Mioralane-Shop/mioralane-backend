import { Router, RequestHandler } from 'express';
import { protect, adminOnly } from '../middleware/auth.middleware';
import { createCombo, getCombos, getComboByIdOrSlug, updateCombo } from './combo.controller';

const router = Router();

// Public routes
router.get('/', getCombos as RequestHandler);
router.get('/:idOrSlug', getComboByIdOrSlug as RequestHandler);

// Admin-only routes
router.post(
    '/',
    protect as RequestHandler,
    adminOnly as RequestHandler,
    createCombo as RequestHandler
);

router.put(
    '/:id',
    protect as RequestHandler,
    adminOnly as RequestHandler,
    updateCombo as RequestHandler
);

export default router;
