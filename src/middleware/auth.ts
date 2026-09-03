import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { User } from '../models';
import { AppError } from './errorHandler';
import { AuthRequest } from './auth.types';

export * from './auth.types';

export function signToken(payload: { sub: string; role: string; email: string }): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
}

export async function authenticate(req: AuthRequest, _res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AppError(401, 'Authentication required.');
    }

    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, env.JWT_SECRET) as { sub: string; role: string; email: string };

    const user = await User.findById(decoded.sub).select('name email role isActive teamName');

    if (!user || !user.isActive) {
      throw new AppError(401, 'Invalid or expired token.');
    }

    req.user = {
      id: user._id.toString(),
      role: user.role,
      email: user.email,
      name: user.name,
    };

    next();
  } catch (err) {
    if (err instanceof AppError) {
      return next(err);
    }
    next(new AppError(401, 'Invalid or expired token.'));
  }
}

export function requireRoles(...roles: string[]) {
  return (req: AuthRequest, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError(403, 'Insufficient permissions.'));
    }
    next();
  };
}
