import http from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { User } from '../models';
import { remoteCallPresence, SocketRole } from '../services/remoteCallPresence';
import {
  applyCallStatus,
  endRemoteCall,
  initiateRemoteCall,
} from '../services/remoteCallService';

export interface AuthedSocketData {
  userId: string;
  role: string;
  email: string;
  name: string;
}

function parsePlatform(raw: unknown): SocketRole {
  const p = String(raw || '').toLowerCase();
  if (p === 'android') return 'android';
  if (p === 'windows' || p === 'macos' || p === 'linux' || p === 'desktop') return 'windows';
  return 'other';
}

async function authenticateSocket(socket: Socket): Promise<AuthedSocketData | null> {
  const token =
    (socket.handshake.auth?.token as string | undefined) ||
    (typeof socket.handshake.headers.authorization === 'string' &&
    socket.handshake.headers.authorization.startsWith('Bearer ')
      ? socket.handshake.headers.authorization.slice(7)
      : undefined);

  if (!token) return null;

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as {
      sub: string;
      role: string;
      email: string;
    };
    const user = await User.findById(decoded.sub).select('name email role isActive');
    if (!user || !user.isActive) return null;
    return {
      userId: user._id.toString(),
      role: user.role,
      email: user.email,
      name: user.name,
    };
  } catch {
    return null;
  }
}

export function createSocketServer(httpServer: http.Server): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: env.NODE_ENV === 'development' ? true : env.CORS_ORIGIN || false,
      credentials: true,
    },
    path: '/socket.io',
  });

  remoteCallPresence.attach(io);

  io.use(async (socket, next) => {
    const user = await authenticateSocket(socket);
    if (!user) {
      return next(new Error('UNAUTHORIZED'));
    }
    (socket.data as Record<string, unknown>).userId = user.userId;
    (socket.data as Record<string, unknown>).role = user.role;
    (socket.data as Record<string, unknown>).email = user.email;
    (socket.data as Record<string, unknown>).name = user.name;
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data as AuthedSocketData;

    socket.emit('socket:ready', {
      agentId: user.userId,
      timestamp: new Date().toISOString(),
    });

    socket.on('device:register', async (payload, ack) => {
      try {
        const deviceId = String(payload?.deviceId || '').trim();
        if (!deviceId) {
          ack?.({ ok: false, code: 'INVALID_PAYLOAD', message: 'deviceId is required.' });
          return;
        }
        const platform = parsePlatform(payload?.platform);
        const session = await remoteCallPresence.register(socket, {
          agentId: user.userId,
          deviceId,
          platform,
          deviceName: payload?.deviceName ? String(payload.deviceName) : undefined,
        });

        // Join agent room for optional broadcasts.
        await socket.join(`agent:${user.userId}`);
        if (platform === 'android') {
          await socket.join(`agent:${user.userId}:android`);
        } else if (platform === 'windows') {
          await socket.join(`agent:${user.userId}:windows`);
        }

        const android = remoteCallPresence.getAndroidForAgent(user.userId);
        ack?.({
          ok: true,
          deviceId: session.deviceId,
          platform: session.platform,
          androidOnline: !!android,
          androidDeviceId: android?.deviceId ?? null,
        });

        // Notify Windows sessions about Android presence.
        if (platform === 'android') {
          for (const sid of remoteCallPresence.getWindowsSockets(user.userId)) {
            io.to(sid).emit('device:presence', {
              platform: 'android',
              online: true,
              deviceId: session.deviceId,
              timestamp: new Date().toISOString(),
            });
          }
        }
      } catch (err) {
        ack?.({
          ok: false,
          code: 'REGISTER_FAILED',
          message: err instanceof Error ? err.message : 'Registration failed.',
        });
      }
    });

    socket.on('device:ping', () => {
      const session = remoteCallPresence.getSession(socket.id);
      if (session) remoteCallPresence.touch(session.agentId, session.deviceId);
    });

    socket.on('call:initiate', async (payload, ack) => {
      const session = remoteCallPresence.getSession(socket.id);
      if (!session || session.platform === 'android') {
        ack?.({
          ok: false,
          code: 'FORBIDDEN',
          message: 'Only the Windows CRM may initiate remote calls.',
        });
        return;
      }

      const result = await initiateRemoteCall(io, {
        agentId: user.userId,
        callId: payload?.callId,
        leadId: String(payload?.leadId || ''),
        customerId: payload?.customerId ? String(payload.customerId) : undefined,
        phoneNumber: payload?.phoneNumber ? String(payload.phoneNumber) : undefined,
      });

      ack?.(result);

      if (result.ok) {
        // Echo pending status to Windows immediately.
        socket.emit('call:status', {
          callId: result.callId,
          status: 'pending',
          timestamp: result.timestamp,
        });
      }
    });

    socket.on('call:status', async (payload, ack) => {
      const session = remoteCallPresence.getSession(socket.id);
      if (!session) {
        ack?.({ ok: false, message: 'Device not registered.' });
        return;
      }

      const result = await applyCallStatus(io, {
        agentId: user.userId,
        callId: String(payload?.callId || ''),
        status: String(payload?.status || ''),
        timestamp: payload?.timestamp ? String(payload.timestamp) : undefined,
        error: payload?.error ? String(payload.error) : undefined,
      });
      ack?.(result);
    });

    socket.on('call:end', async (payload, ack) => {
      const session = remoteCallPresence.getSession(socket.id);
      if (!session) {
        ack?.({ ok: false, message: 'Device not registered.' });
        return;
      }

      const result = await endRemoteCall(io, {
        agentId: user.userId,
        callId: String(payload?.callId || ''),
      });
      ack?.(result);
    });

    socket.on('disconnect', () => {
      const session = remoteCallPresence.getSession(socket.id);
      remoteCallPresence.unregisterSocket(socket.id);
      if (session?.platform === 'android') {
        for (const sid of remoteCallPresence.getWindowsSockets(session.agentId)) {
          io.to(sid).emit('device:presence', {
            platform: 'android',
            online: false,
            deviceId: session.deviceId,
            timestamp: new Date().toISOString(),
          });
        }
      }
    });
  });

  return io;
}
