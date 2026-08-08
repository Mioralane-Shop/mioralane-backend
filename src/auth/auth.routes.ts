import { Router, Response, RequestHandler } from 'express';
import { registerUser, loginUser, logoutUser, googleLogin } from './auth.controller';
import { protect, AuthenticatedRequest } from '../middleware/auth.middleware';

const router = Router();

router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/google', googleLogin);
router.post('/logout', logoutUser);

/**
 * GET /me
 * Returns the authenticated user decoded from the JWT.
 * Used to validate that a token is still valid.
 */
router.get(
  '/me',
  protect,
  ((req: AuthenticatedRequest, res: Response) => {
    res.status(200).json({
      success: true,
      message: 'Token is valid!',
      user: req.user,
    });
  }) as RequestHandler
);

export default router;
