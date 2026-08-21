import { Request, Response } from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { UserModel } from './user.model';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_do_not_use_in_prod';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

/**
 * Sets the JWT as an httpOnly cookie for enhanced security.
 * The token is also returned in the JSON body so mobile / native clients
 * and the Bearer-header flow continue to work.
 */
const setAuthCookie = (res: Response, token: string): void => {
  const isProduction = process.env.NODE_ENV === 'production';

  res.cookie('token', token, {
    httpOnly: true,               // Not accessible via JavaScript (XSS protection)
    secure: isProduction,         // HTTPS only in production
    sameSite: isProduction ? 'none' : 'lax', // 'none' required for cross-domain (mioralane.com ↔ vercel.app)
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/',
  });
};

/**
 * Generates a signed JWT for the given user payload.
 */
const generateToken = (payload: { id: string; role: 'user' | 'admin' }): string => {
  const options: jwt.SignOptions = { expiresIn: JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] };
  return jwt.sign(payload, JWT_SECRET, options);
};

/**
 * Builds a standard error message, taking DB connectivity into account.
 */
const errorMessage = (): string =>
  mongoose.connection.readyState !== 1
    ? 'Database not connected — check MongoDB Atlas IP whitelist'
    : 'Internal server error';

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a new user account
 *     description: Creates a new account and returns a JWT token + httpOnly cookie.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, email, password]
 *             properties:
 *               username:
 *                 type: string
 *                 example: johndoe
 *               email:
 *                 type: string
 *                 format: email
 *                 example: john@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 minLength: 6
 *                 example: "securePass123"
 *     responses:
 *       201:
 *         description: User registered successfully
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
 *                 token:
 *                   type: string
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     username:
 *                       type: string
 *                     email:
 *                       type: string
 *                     role:
 *                       type: string
 *       400:
 *         description: Missing required fields
 *       409:
 *         description: Username or email already exists
 *       500:
 *         description: Internal server error
 */
export const registerUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, email, password } = req.body || {};

    if (!username || !email || !password) {
      res.status(400).json({ success: false, message: 'Username, email, and password are required' });
      return;
    }

    // Check if the user already exists by username or email
    const existingUser = await UserModel.findOne({
      $or: [{ username }, { email: email.toLowerCase() }],
    });
    if (existingUser) {
      const field = existingUser.username === username ? 'Username' : 'Email';
      res.status(409).json({ success: false, message: `${field} already exists` });
      return;
    }

    // Password is hashed automatically by the Mongoose pre('save') hook
    const user = await UserModel.create({ username, email: email.toLowerCase(), password });

    // Generate JWT
    const token = generateToken({ id: user._id.toString(), role: user.role });

    // Set httpOnly cookie
    setAuthCookie(res, token);

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('[registerUser]', error);
    res.status(500).json({ success: false, message: errorMessage() });
  }
};

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Login with username/email and password
 *     description: Authenticates a user and returns a JWT token + httpOnly cookie.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password]
 *             properties:
 *               username:
 *                 type: string
 *                 description: Username or email address
 *                 example: johndoe
 *               email:
 *                 type: string
 *                 description: Email address
 *                 example: admin@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 example: "securePass123"
 *     responses:
 *       200:
 *         description: Login successful — returns token
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 token:
 *                   type: string
 *                   description: JWT bearer token
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     username:
 *                       type: string
 *                     email:
 *                       type: string
 *                     role:
 *                       type: string
 *       400:
 *         description: Invalid credentials or missing fields
 *       500:
 *         description: Internal server error
 */
export const loginUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, email, password } = req.body || {};
    const loginIdentifier = username ?? email;

    if (!loginIdentifier || !password) {
      res.status(400).json({ success: false, message: 'Username or email and password are required' });
      return;
    }

    // Allow login by username OR email
    const user = await UserModel.findOne({
      $or: [{ username: loginIdentifier }, { email: loginIdentifier.toLowerCase() }],
    }).select('+password');

    if (!user) {
      res.status(400).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    // Compare password using bcrypt
    const isMatch = await bcrypt.compare(password, user.password!);
    if (!isMatch) {
      res.status(400).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    // Generate JWT
    const token = generateToken({ id: user._id.toString(), role: user.role });

    // Set httpOnly cookie
    setAuthCookie(res, token);

    res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('[loginUser]', error);
    res.status(500).json({ success: false, message: errorMessage() });
  }
};

/**
 * @swagger
 * /api/auth/google:
 *   post:
 *     tags: [Auth]
 *     summary: Login or register via Google OAuth
 *     description: Verifies a Google ID token and returns a Mioralane JWT.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [credential]
 *             properties:
 *               credential:
 *                 type: string
 *                 description: Google ID token from the frontend
 *     responses:
 *       200:
 *         description: Google auth successful
 *       400:
 *         description: Invalid or expired Google token
 */
export const googleLogin = async (req: Request, res: Response): Promise<void> => {
  try {
    const { credential } = req.body || {};

    if (!credential) {
      res.status(400).json({ success: false, message: 'Google credential is required' });
      return;
    }

    // Verify the Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      res.status(400).json({ success: false, message: 'Invalid Google token payload' });
      return;
    }

    // Ensure the Google account email is verified
    if (payload.email_verified !== true) {
      res.status(400).json({
        success: false,
        message: 'Google account email is not verified — please verify your email with Google first',
      });
      return;
    }

    const { email, sub: googleId, name, picture } = payload;

    // Find existing user by Google ID, or by email linked to a different provider
    let user = await UserModel.findOne({
      $or: [{ googleId }, { email }],
    });

    if (user) {
      // Existing user — link Google if not already linked
      if (!user.googleId) {
        user.googleId = googleId;
        user.avatar = user.avatar || picture;
        await user.save();
      }
    } else {
      // New Google user — create account
      const baseUsername = (name || email.split('@')[0]).replace(/\s+/g, '').toLowerCase();
      // Ensure unique username
      let username = baseUsername;
      let counter = 1;
      while (await UserModel.exists({ username })) {
        username = `${baseUsername}${counter}`;
        counter++;
      }

      user = await UserModel.create({
        username,
        email,
        googleId,
        avatar: picture,
        authProvider: 'google',
      });
    }

    // Generate Mioralane JWT
    const token = generateToken({ id: user._id.toString(), role: user.role });

    // Set httpOnly cookie
    setAuthCookie(res, token);

    res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('[googleLogin]', error);

    // Distinguish known Google API errors
    const message =
      error instanceof Error && error.message.includes('Token used too late')
        ? 'Google token has expired — please sign in again'
        : error instanceof Error && error.message.includes('Wrong recipient')
          ? 'Google token mismatch — check your CLIENT_ID'
          : errorMessage();

    res.status(400).json({ success: false, message });
  }
};

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Logout and clear session cookie
 *     description: Clears the httpOnly auth cookie. The client must also discard the JWT.
 *     responses:
 *       200:
 *         description: Logged out successfully
 */
export const logoutUser = async (_req: Request, res: Response): Promise<void> => {
  const isProduction = process.env.NODE_ENV === 'production';

  res.clearCookie('token', {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
  });

  res.status(200).json({ success: true, message: 'Logged out successfully' });
};


