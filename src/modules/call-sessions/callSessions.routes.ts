import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import {
  endCallSession,
  getActiveCallSession,
  startCallSession,
  subscribe,
} from '../../services/callSessionHub';

export const callSessionsRouter = Router();

const startSchema = z.object({
  lead_id: z.string().min(1),
  phone_number: z.string().min(1),
  lead_name: z.string().optional(),
});

/** Phone app: call connected — notify this agent's desktop listeners. */
callSessionsRouter.post('/start', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'Invalid request body.');

    const session = startCallSession({
      agentId: req.user!.id,
      leadId: parsed.data.lead_id,
      leadName: parsed.data.lead_name ?? 'Unknown lead',
      phoneNumber: parsed.data.phone_number,
    });

    res.status(201).json({ data: session });
  } catch (err) {
    next(err);
  }
});

/** Phone app: call ended — clear active session. */
callSessionsRouter.post('/end', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const session = endCallSession(req.user!.id);
    res.json({ data: session });
  } catch (err) {
    next(err);
  }
});

/** Desktop app: poll fallback if SSE is unavailable. */
callSessionsRouter.get('/active', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const session = getActiveCallSession(req.user!.id);
    res.json({ data: session });
  } catch (err) {
    next(err);
  }
});

/** Desktop app: Server-Sent Events stream for live call notifications. */
callSessionsRouter.get('/stream', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    subscribe(req.user!.id, res);

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 25000);

    res.on('close', () => clearInterval(heartbeat));
  } catch (err) {
    next(err);
  }
});
