import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { UserModel } from './user.model';

/**
 * POST /register
 * Creates a new user account.
 */
export const registerUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ success: false, message: 'Username and password are required' });
      return;
    }

    // Check if the user already exists
    const existingUser = await UserModel.findOne({ username });
    if (existingUser) {
      res.status(409).json({ success: false, message: 'Username already exists' });
      return;
    }

    // TODO: Hash password before storing (e.g., using bcrypt)
    const user = await UserModel.create({ username, password });

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      user,
    });
  } catch (error) {
    const message =
      mongoose.connection.readyState !== 1
        ? 'Database not connected — check MongoDB Atlas IP whitelist'
        : 'Internal server error';
    res.status(500).json({ success: false, message });
  }
};

/**
 * POST /login
 * Authenticates a user with username and password.
 */
export const loginUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ success: false, message: 'Username and password are required' });
      return;
    }

    // Find user by username
    const user = await UserModel.findOne({ username });
    if (!user) {
      res.status(400).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    // Validate password
    // TODO: Use bcrypt.compare() when passwords are hashed
    if (user.password !== password) {
      res.status(400).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    res.status(200).json({
      success: true,
      message: 'Login successful',
      user,
    });
  } catch (error) {
    const message =
      mongoose.connection.readyState !== 1
        ? 'Database not connected — check MongoDB Atlas IP whitelist'
        : 'Internal server error';
    res.status(500).json({ success: false, message });
  }
};

/**
 * POST /logout
 * Ends the current user session.
 *
 * NOTE: The API is currently stateless (login does not yet issue a JWT), so
 * there is no server-side token to invalidate here. Once token auth is added,
 * read the token from the Authorization header and blacklist/denylist it here
 * (e.g., in Redis) until it expires.
 */
export const logoutUser = async (
  _req: Request,
  res: Response
): Promise<void> => {
  res.status(200).json({ success: true, message: 'Logged out successfully' });
};

