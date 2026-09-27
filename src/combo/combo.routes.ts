import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { createCombo, deleteCombo, getCombos, getComboByIdOrSlug, updateCombo } from './combo.controller';
import { createComboSchema, updateComboSchema } from './combo.schemas';

const router = Router();

// Public routes
router.get('/', getCombos as RequestHandler);
router.get('/:idOrSlug', getComboByIdOrSlug as RequestHandler);

// Admin-only routes. This router also serves public GETs, so the guard is
// applied per route — a router-level `use` would lock out the storefront.
// `validate()` runs AFTER the guard on purpose: an unauthenticated caller should
// get 401 from the guard, not a 400 that reveals the body contract.
router.post(
    '/',
    ...adminGuard,
    validate({ body: createComboSchema }),
    createCombo as RequestHandler
);

router.put(
    '/:id',
    ...adminGuard,
    validate({ body: updateComboSchema }),
    updateCombo as RequestHandler
);

router.delete('/:id', ...adminGuard, deleteCombo as RequestHandler);

export default router;
