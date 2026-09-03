import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest } from './auth.types';

export function requestIdMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

export function requestLogger(req: AuthRequest, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logEntry = {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: duration,
      userId: req.user?.id,
      ...(res.statusCode >= 400 && req.path.includes('recordings') && {
        hasFile: !!(req as AuthRequest & { file?: Express.Multer.File }).file,
        bodyFields: Object.keys(req.body || {}),
      }),
    };
    if (process.env.NODE_ENV !== 'test') {
      console.log(JSON.stringify(logEntry));
    }
  });
  next();
}
