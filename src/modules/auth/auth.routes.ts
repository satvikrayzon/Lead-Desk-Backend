import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { User } from '../../models';
import { comparePassword } from '../../utils/password';
import {
  signAccessToken,
  signRefreshToken,
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
  refreshToken: z.string().min(1, 'Refresh token is required.'),
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
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        team_name: user.teamName ?? null,
        team: user.teamName ? { id: null, name: user.teamName } : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Exchange a valid refresh token for a new access + refresh pair (rotation). */
authRouter.post('/refresh', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'Invalid request body.');
    }

    let decoded: { sub: string; role: string; email: string };
    try {
      decoded = verifyRefreshToken(parsed.data.refreshToken);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(401, 'Invalid refresh token.');
    }

    const user = await User.findById(decoded.sub);
    if (!user || !user.isActive) {
      throw new AppError(401, 'Invalid refresh token.');
    }

    const tokens = tokenPairFor(user);

    res.json({
      ...tokens,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        team_name: user.teamName ?? null,
        team: user.teamName ? { id: null, name: user.teamName } : null,
      },
    });
  } catch (err) {
    next(err);
  }
});
