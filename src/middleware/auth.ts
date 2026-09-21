import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { User } from '../models';
import { AppError } from './errorHandler';
import { AuthRequest } from './auth.types';

export * from './auth.types';

type TokenKind = 'access' | 'refresh';

type JwtUserPayload = { sub: string; role: string; email: string; typ?: TokenKind };

function signJwt(payload: JwtUserPayload & { typ: TokenKind }, expiresIn: string): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn } as jwt.SignOptions);
}

/** Short-lived access JWT for API + Socket.IO. */
export function signAccessToken(payload: { sub: string; role: string; email: string }): string {
  return signJwt({ ...payload, typ: 'access' }, env.JWT_EXPIRES_IN);
}

/** Long-lived refresh JWT — used only at /auth/refresh. */
export function signRefreshToken(payload: { sub: string; role: string; email: string }): string {
  return signJwt({ ...payload, typ: 'refresh' }, env.JWT_REFRESH_EXPIRES_IN);
}

/** @deprecated Prefer signAccessToken. Kept for older call sites. */
export function signToken(payload: { sub: string; role: string; email: string }): string {
  return signAccessToken(payload);
}

export function verifyAccessToken(token: string): { sub: string; role: string; email: string } {
  const decoded = jwt.verify(token, env.JWT_SECRET) as JwtUserPayload;
  // Legacy tokens have no typ — treat as access.
  if (decoded.typ && decoded.typ !== 'access') {
    throw new AppError(401, 'Invalid or expired token.');
  }
  return { sub: decoded.sub, role: decoded.role, email: decoded.email };
}

export function verifyRefreshToken(token: string): { sub: string; role: string; email: string } {
  const decoded = jwt.verify(token, env.JWT_SECRET) as JwtUserPayload;
  if (decoded.typ !== 'refresh') {
    throw new AppError(401, 'Invalid refresh token.');
  }
  return { sub: decoded.sub, role: decoded.role, email: decoded.email };
}

export async function authenticate(req: AuthRequest, _res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AppError(401, 'Authentication required.');
    }

    const token = authHeader.slice(7);
    const decoded = verifyAccessToken(token);

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
