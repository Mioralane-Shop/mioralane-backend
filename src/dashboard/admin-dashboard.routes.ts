import { Router, RequestHandler } from 'express';
import { adminOnly, protect } from '../middleware/auth.middleware';
import { getAdminDashboardSummary } from './admin-dashboard.controller';

const router = Router();

router.get(
  '/summary',
  protect as RequestHandler,
  adminOnly as RequestHandler,
  getAdminDashboardSummary as RequestHandler
);

export default router;
