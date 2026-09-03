import { Router, Request, Response } from 'express';
import { env } from '../../config/env';
import { isDatabaseConnected } from '../../config/database';
import { checkS3Connection } from '../../config/s3';

export const healthRouter = Router();

healthRouter.get('/', async (_req: Request, res: Response) => {
  let dbStatus = 'ok';
  let s3Status: string;

  if (!isDatabaseConnected()) {
    dbStatus = 'error';
  }

  if (!env.S3_ENABLED) {
    s3Status = 'disabled';
  } else {
    try {
      const s3Ok = await checkS3Connection();
      s3Status = s3Ok ? 'ok' : 'error';
    } catch {
      s3Status = 'error';
    }
  }

  const s3Healthy = s3Status === 'ok' || s3Status === 'disabled';
  const status = dbStatus === 'ok' && s3Healthy ? 'ok' : 'degraded';
  const statusCode = status === 'ok' ? 200 : 503;

  res.status(statusCode).json({
    status,
    db: dbStatus,
    s3: s3Status,
  });
});
