import { Router, Response, RequestHandler } from 'express';
import { registerUser, loginUser, logoutUser, googleLogin } from './auth.controller';
import { protect, AuthenticatedRequest } from '../middleware/auth.middleware';
import { UserModel } from './user.model';

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
/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get current authenticated user
 *     description: Validates the JWT and returns the decoded user payload.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Token is valid
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     role:
 *                       type: string
 *       401:
 *         description: Not authorized — token missing, expired, or invalid
 */
router.get(
  '/me',
  protect,
  (async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ success: false, message: 'Not authorized' });
      return;
    }

    const user = await UserModel.findById(userId);

    if (!user) {
      res.status(401).json({ success: false, message: 'User session is no longer valid' });
      return;
    }

    res.status(200).json({
      success: true,
      message: 'Token is valid!',
      user: {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        role: user.role,
        createdAt: user.createdAt,
      },
    });
  }) as RequestHandler
);

export default router;
