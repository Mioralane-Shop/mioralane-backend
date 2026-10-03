import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { createCombo, deleteCombo, getCombos, getComboByIdOrSlug, updateCombo } from './combo.controller';
import { createComboSchema, updateComboSchema } from './combo.schemas';
import { objectIdParam } from '../utils/validation';

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
    validate({ params: objectIdParam('id'), message: 'Invalid combo ID' }),
    updateCombo as RequestHandler
);

// Both admin routes take an ObjectId `:id`; the param schema refuses a malformed
// one before the handler with the wording the handler already returned, and runs
// after the body schema so the reporting order is unchanged (P1.6.1). The public
// `:idOrSlug` route above is excluded — a slug is a valid value there.
router.delete(
    '/:id',
    ...adminGuard,
    validate({ params: objectIdParam('id'), message: 'Invalid combo ID' }),
    deleteCombo as RequestHandler
);

export default router;
