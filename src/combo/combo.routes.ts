import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import { createCombo, deleteCombo, getCombos, getComboByIdOrSlug, updateCombo } from './combo.controller';

const router = Router();

// Public routes
router.get('/', getCombos as RequestHandler);
router.get('/:idOrSlug', getComboByIdOrSlug as RequestHandler);

// Admin-only routes. This router also serves public GETs, so the guard is
// applied per route — a router-level `use` would lock out the storefront.
router.post('/', ...adminGuard, createCombo as RequestHandler);

router.put('/:id', ...adminGuard, updateCombo as RequestHandler);

router.delete('/:id', ...adminGuard, deleteCombo as RequestHandler);

export default router;
