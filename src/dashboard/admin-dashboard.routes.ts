import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import { getAdminDashboardSummary } from './admin-dashboard.controller';

const router = Router();

// Every route on this router is admin-only.
router.use(...adminGuard);

router.get('/summary', getAdminDashboardSummary as RequestHandler);

export default router;
