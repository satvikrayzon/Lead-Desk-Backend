import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { User } from '../../models';
import { comparePassword } from '../../utils/password';
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  AuthRequest,
} from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import { loginRateLimiter } from '../../middleware/rateLimit';
import { createAuditLog } from '../../utils/helpers';

const loginSchema = z.object({
  username: z.string().min(1, 'Username is required.'),
  password: z.string().min(1, 'Password is required.'),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

function tokenPairFor(user: { _id: { toString(): string }; role: string; email: string }) {
  const payload = {
    sub: user._id.toString(),
    role: user.role,
    email: user.email,
  };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  return { accessToken, refreshToken, token: accessToken };
}

function userJson(user: {
  _id: { toString(): string };
  name: string;
  email: string;
  role: string;
  teamName?: string | null;
}) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    team_name: user.teamName ?? null,
    team: user.teamName ? { id: null, name: user.teamName } : null,
  };
}

export const authRouter = Router();

authRouter.post('/login', loginRateLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'Invalid request body.');
    }

    const { username, password } = parsed.data;

    const user = await User.findOne({
      $or: [{ email: username.toLowerCase() }, { username }],
      isActive: true,
    });

    if (!user) {
      throw new AppError(401, 'Invalid username or password.');
    }

    const valid = await comparePassword(password, user.passwordHash);
    if (!valid) {
      throw new AppError(401, 'Invalid username or password.');
    }

    const tokens = tokenPairFor(user);

    await createAuditLog({
      userId: user._id.toString(),
      action: 'auth.login',
      entityType: 'user',
      entityId: user._id.toString(),
      ipAddress: req.ip,
    });

    res.json({
      ...tokens,
      user: userJson(user),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Issue a fresh access (+ refresh) pair.
 *
 * Accepts either:
 * - `{ refreshToken }` body (preferred, long-lived), or
 * - `Authorization: Bearer <access>` to bootstrap a refresh token for clients
 *   that logged in before refresh tokens existed (while access is still valid).
 */
authRouter.post('/refresh', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = refreshSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, 'Invalid request body.');
    }

    let userId: string | null = null;

    const refreshToken = parsed.data.refreshToken?.trim();
    if (refreshToken) {
      try {
        const decoded = verifyRefreshToken(refreshToken);
        userId = decoded.sub;
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError(401, 'Invalid refresh token.');
      }
    } else {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        throw new AppError(401, 'Refresh token required.');
      }
      try {
        const decoded = verifyAccessToken(authHeader.slice(7));
        userId = decoded.sub;
      } catch {
        throw new AppError(401, 'Invalid or expired token.');
      }
    }

    const user = await User.findById(userId);
    if (!user || !user.isActive) {
      throw new AppError(401, 'Invalid refresh token.');
    }

    const tokens = tokenPairFor(user);

    res.json({
      ...tokens,
      user: userJson(user),
    });
  } catch (err) {
    next(err);
  }
});
