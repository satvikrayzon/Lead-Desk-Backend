import { Response } from 'express';
import { AgentDevice } from '../models/AgentDevice';

type SseRole = 'android' | 'windows';

interface PendingCommand {
  type: 'call:request' | 'call:end';
  payload: Record<string, unknown>;
  createdAt: number;
}

/** HTTP/SSE presence + command fan-out (works behind nginx without WebSocket). */
class RemoteCallHttpHub {
  private androidSubs = new Map<string, Set<Response>>();
  private windowsSubs = new Map<string, Set<Response>>();
  private pendingByAgent = new Map<string, PendingCommand[]>();
  private onlineAndroid = new Map<string, { deviceId: string; lastSeen: number }>();
  private onlineWindows = new Map<string, { deviceId: string; lastSeen: number }>();

  private setFor(role: SseRole, agentId: string): Set<Response> {
    const map = role === 'android' ? this.androidSubs : this.windowsSubs;
    let set = map.get(agentId);
    if (!set) {
      set = new Set();
      map.set(agentId, set);
    }
    return set;
  }

  async upsertDevice(input: {
    agentId: string;
    deviceId: string;
    platform: SseRole;
    deviceName?: string;
  }) {
    const now = Date.now();
    if (input.platform === 'android') {
      this.onlineAndroid.set(input.agentId, { deviceId: input.deviceId, lastSeen: now });
      this.broadcast(input.agentId, 'windows', 'device:presence', {
        platform: 'android',
        online: true,
        deviceId: input.deviceId,
        timestamp: new Date().toISOString(),
      });
    } else {
      this.onlineWindows.set(input.agentId, { deviceId: input.deviceId, lastSeen: now });
    }

    await AgentDevice.findOneAndUpdate(
      { agentId: input.agentId, deviceId: input.deviceId },
      {
        $set: {
          platform: input.platform,
          deviceName: input.deviceName,
          online: true,
          lastSeen: new Date(),
          socketId: `http:${input.platform}:${input.deviceId}`,
        },
      },
      { upsert: true }
    );
  }

  touch(agentId: string, platform: SseRole, deviceId: string) {
    const now = Date.now();
    if (platform === 'android') {
      this.onlineAndroid.set(agentId, { deviceId, lastSeen: now });
    } else {
      this.onlineWindows.set(agentId, { deviceId, lastSeen: now });
    }
    void AgentDevice.updateOne(
      { agentId, deviceId },
      { $set: { lastSeen: new Date(), online: true } }
    );
  }

  isAndroidOnline(agentId: string): { online: boolean; deviceId?: string } {
    const cur = this.onlineAndroid.get(agentId);
    if (!cur) return { online: false };
    if (Date.now() - cur.lastSeen > 45_000) {
      this.onlineAndroid.delete(agentId);
      return { online: false };
    }
    // Prefer live SSE subscription if present.
    const subs = this.androidSubs.get(agentId);
    if (subs && subs.size > 0) return { online: true, deviceId: cur.deviceId };
    return { online: true, deviceId: cur.deviceId };
  }

  /** True only when Android currently has an SSE stream open. */
  hasAndroidStream(agentId: string): boolean {
    const set = this.androidSubs.get(agentId);
    return !!set && set.size > 0;
  }

  async subscribe(
    agentId: string,
    role: SseRole,
    res: Response,
    deviceId: string,
    deviceName?: string
  ) {
    const set = this.setFor(role, agentId);
    set.add(res);
    await this.upsertDevice({ agentId, deviceId, platform: role, deviceName });

    res.on('close', () => {
      set.delete(res);
      if (set.size === 0) {
        if (role === 'android') {
          this.androidSubs.delete(agentId);
          this.broadcast(agentId, 'windows', 'device:presence', {
            platform: 'android',
            online: false,
            deviceId,
            timestamp: new Date().toISOString(),
          });
          void AgentDevice.updateOne(
            { agentId, deviceId },
            { $set: { online: false, lastSeen: new Date() }, $unset: { socketId: 1 } }
          );
        } else {
          this.windowsSubs.delete(agentId);
        }
      }
    });

    const android = this.isAndroidOnline(agentId);
    writeEvent(res, 'connected', {
      agentId,
      role,
      androidOnline: android.online && this.hasAndroidStream(agentId),
      androidDeviceId: android.deviceId ?? null,
    });

    if (role === 'android') {
      const pending = this.pendingByAgent.get(agentId) ?? [];
      this.pendingByAgent.delete(agentId);
      for (const cmd of pending) writeEvent(res, cmd.type, cmd.payload);
    }

    if (role === 'windows') {
      writeEvent(res, 'device:presence', {
        platform: 'android',
        online: this.hasAndroidStream(agentId),
        deviceId: android.deviceId ?? null,
        timestamp: new Date().toISOString(),
      });
    }
  }

  sendToAndroid(agentId: string, type: 'call:request' | 'call:end', payload: Record<string, unknown>) {
    const set = this.androidSubs.get(agentId);
    if (set && set.size > 0) {
      for (const res of set) writeEvent(res, type, payload);
      return true;
    }
    const queue = this.pendingByAgent.get(agentId) ?? [];
    queue.push({ type, payload, createdAt: Date.now() });
    this.pendingByAgent.set(agentId, queue.slice(-5));
    return false;
  }

  broadcastStatus(agentId: string, payload: Record<string, unknown>) {
    this.broadcast(agentId, 'windows', 'call:status', payload);
    this.broadcast(agentId, 'android', 'call:status', payload);
  }

  private broadcast(agentId: string, role: SseRole, event: string, data: unknown) {
    const set = role === 'android' ? this.androidSubs.get(agentId) : this.windowsSubs.get(agentId);
    if (!set) return;
    for (const res of set) writeEvent(res, event, data);
  }
}

function writeEvent(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export const remoteCallHttpHub = new RemoteCallHttpHub();
