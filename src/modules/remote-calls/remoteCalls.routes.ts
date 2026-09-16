import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import { remoteCallHttpHub } from '../../services/remoteCallHttpHub';
import {
  applyCallStatus,
  endRemoteCall,
  initiateRemoteCall,
} from '../../services/remoteCallService';

export const remoteCallsRouter = Router();

const registerSchema = z.object({
  device_id: z.string().min(1),
  platform: z.enum(['android', 'windows']),
  device_name: z.string().optional(),
});

const initiateSchema = z.object({
  call_id: z.string().optional(),
  lead_id: z.string().min(1),
  customer_id: z.string().optional(),
  phone_number: z.string().optional(),
});

const statusSchema = z.object({
  call_id: z.string().min(1),
  status: z.string().min(1),
  timestamp: z.string().optional(),
  error: z.string().optional(),
  duration_seconds: z.number().int().min(0).optional(),
});

const endSchema = z.object({
  call_id: z.string().min(1),
});

/** Register / heartbeat device presence over plain HTTP. */
remoteCallsRouter.post('/device', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'Invalid device payload.');

    await remoteCallHttpHub.upsertDevice({
      agentId: req.user!.id,
      deviceId: parsed.data.device_id,
      platform: parsed.data.platform,
      deviceName: parsed.data.device_name,
    });

    const android = remoteCallHttpHub.isAndroidOnline(req.user!.id);
    res.json({
      ok: true,
      android_online: remoteCallHttpHub.hasAndroidStream(req.user!.id),
      android_device_id: android.deviceId ?? null,
    });
  } catch (err) {
    next(err);
  }
});

remoteCallsRouter.post('/device/ping', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'Invalid device payload.');
    remoteCallHttpHub.touch(req.user!.id, parsed.data.platform, parsed.data.device_id);
    res.json({
      ok: true,
      android_online: remoteCallHttpHub.hasAndroidStream(req.user!.id),
    });
  } catch (err) {
    next(err);
  }
});

remoteCallsRouter.get('/device/android', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json({
      data: {
        online: remoteCallHttpHub.hasAndroidStream(req.user!.id),
        device_id: remoteCallHttpHub.isAndroidOnline(req.user!.id).deviceId ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Windows: start a remote SIM call. */
remoteCallsRouter.post('/initiate', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = initiateSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'Invalid initiate payload.');

    if (!remoteCallHttpHub.hasAndroidStream(req.user!.id)) {
      res.status(409).json({
        ok: false,
        code: 'ANDROID_DEVICE_OFFLINE',
        message: 'Android calling device is offline.',
      });
      return;
    }

    const result = await initiateRemoteCall(null, {
      agentId: req.user!.id,
      callId: parsed.data.call_id,
      leadId: parsed.data.lead_id,
      customerId: parsed.data.customer_id,
      phoneNumber: parsed.data.phone_number,
    });

    if (!result.ok) {
      const status = result.code === 'ANDROID_DEVICE_OFFLINE' ? 409 : 400;
      res.status(status).json(result);
      return;
    }

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/** Android: report call status. */
remoteCallsRouter.post('/status', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'Invalid status payload.');

    const result = await applyCallStatus(null, {
      agentId: req.user!.id,
      callId: parsed.data.call_id,
      status: parsed.data.status,
      timestamp: parsed.data.timestamp,
      error: parsed.data.error,
      durationSeconds: parsed.data.duration_seconds,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** Windows: request hang-up on Android. */
remoteCallsRouter.post('/end', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = endSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'Invalid end payload.');

    const result = await endRemoteCall(null, {
      agentId: req.user!.id,
      callId: parsed.data.call_id,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * SSE stream for remote calling.
 * Query: ?role=android|windows&device_id=...
 */
remoteCallsRouter.get('/stream', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const role = String(req.query.role || '').toLowerCase();
    const deviceId = String(req.query.device_id || '').trim();
    const deviceName = req.query.device_name ? String(req.query.device_name) : undefined;

    if ((role !== 'android' && role !== 'windows') || !deviceId) {
      throw new AppError(400, 'role and device_id are required.');
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    await remoteCallHttpHub.subscribe(req.user!.id, role, res, deviceId, deviceName);

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
      remoteCallHttpHub.touch(req.user!.id, role, deviceId);
    }, 15000);

    res.on('close', () => clearInterval(heartbeat));
  } catch (err) {
    next(err);
  }
});
