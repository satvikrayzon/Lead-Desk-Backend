import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestIdMiddleware, requestLogger } from './middleware/requestLogger';
import { authenticate } from './middleware/auth';
import { authRouter } from './modules/auth/auth.routes';
import { callSessionsRouter } from './modules/call-sessions/callSessions.routes';
import { leadsRouter } from './modules/leads/leads.routes';
import { recordingsRouter } from './modules/recordings/recordings.routes';
import { healthRouter } from './modules/health/health.routes';
import { adminRouter } from './modules/admin/admin.routes';
import { followUpsRouter } from './modules/followups/followups.routes';
import { remoteCallsRouter } from './modules/remote-calls/remoteCalls.routes';
import { companySettingsRouter } from './modules/settings/companySettings.routes';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Flutter web runs on a random localhost port — reflect the request origin in dev.
  if (env.NODE_ENV === 'development') {
    app.use(cors({ origin: true, credentials: true }));
  } else if (env.CORS_ORIGIN) {
    app.use(cors({ origin: env.CORS_ORIGIN }));
  }

  app.use(requestIdMiddleware);
  app.use(requestLogger);

  app.use('/health', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/call-sessions', authenticate, callSessionsRouter);
  app.use('/api/remote-calls', authenticate, remoteCallsRouter);
  app.use('/api/leads', authenticate, leadsRouter);
  app.use('/api/recordings', authenticate, recordingsRouter);
  app.use('/api/follow-ups', authenticate, followUpsRouter);
  app.use('/api/company-settings', authenticate, companySettingsRouter);
  app.use('/api/admin', authenticate, adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
