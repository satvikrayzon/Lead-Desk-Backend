import { Server, Socket } from 'socket.io';
import { AgentDevice, DevicePlatform } from '../models/AgentDevice';

export type SocketRole = 'android' | 'windows' | 'other';

export interface SocketSession {
  socketId: string;
  agentId: string;
  deviceId: string;
  platform: SocketRole;
  connectedAt: Date;
}

/** In-memory presence for fast routing; Mongo AgentDevice is the durable mirror. */
class RemoteCallPresence {
  private bySocket = new Map<string, SocketSession>();
  /** agentId -> deviceId -> socketId (android devices only for calling) */
  private androidByAgent = new Map<string, Map<string, string>>();
  /** agentId -> set of windows socket ids */
  private windowsByAgent = new Map<string, Set<string>>();

  attach(io: Server) {
    // no-op hook for future metrics; io kept for emit helpers
    void io;
  }

  async register(
    socket: Socket,
    input: { agentId: string; deviceId: string; platform: SocketRole; deviceName?: string }
  ): Promise<SocketSession> {
    const session: SocketSession = {
      socketId: socket.id,
      agentId: input.agentId,
      deviceId: input.deviceId,
      platform: input.platform,
      connectedAt: new Date(),
    };

    // Drop any prior mapping for this socket.
    this.unregisterSocket(socket.id);

    this.bySocket.set(socket.id, session);

    if (input.platform === 'android') {
      let devices = this.androidByAgent.get(input.agentId);
      if (!devices) {
        devices = new Map();
        this.androidByAgent.set(input.agentId, devices);
      }
      // One active Android caller per agent: replace previous socket for same or other device.
      for (const [devId, sockId] of [...devices.entries()]) {
        if (devId !== input.deviceId || sockId !== socket.id) {
          devices.delete(devId);
        }
      }
      devices.set(input.deviceId, socket.id);
    } else if (input.platform === 'windows') {
      let set = this.windowsByAgent.get(input.agentId);
      if (!set) {
        set = new Set();
        this.windowsByAgent.set(input.agentId, set);
      }
      set.add(socket.id);
    }

    const platformDb: DevicePlatform =
      input.platform === 'android' || input.platform === 'windows' ? input.platform : 'other';

    await AgentDevice.findOneAndUpdate(
      { agentId: input.agentId, deviceId: input.deviceId },
      {
        $set: {
          platform: platformDb,
          deviceName: input.deviceName,
          online: true,
          lastSeen: new Date(),
          socketId: socket.id,
        },
      },
      { upsert: true, new: true }
    );

    return session;
  }

  unregisterSocket(socketId: string) {
    const session = this.bySocket.get(socketId);
    if (!session) return;

    this.bySocket.delete(socketId);

    if (session.platform === 'android') {
      const devices = this.androidByAgent.get(session.agentId);
      if (devices) {
        const current = devices.get(session.deviceId);
        if (current === socketId) devices.delete(session.deviceId);
        if (devices.size === 0) {
          this.androidByAgent.delete(session.agentId);
          // No Android left for this agent → clear stuck call lock.
          void import('./remoteCallService').then(({ clearAgentActiveCall }) => {
            clearAgentActiveCall(session.agentId);
          });
        }
      }
      void AgentDevice.updateOne(
        { agentId: session.agentId, deviceId: session.deviceId, socketId },
        { $set: { online: false, lastSeen: new Date() }, $unset: { socketId: 1 } }
      );
    } else if (session.platform === 'windows') {
      const set = this.windowsByAgent.get(session.agentId);
      set?.delete(socketId);
      if (set && set.size === 0) this.windowsByAgent.delete(session.agentId);
      void AgentDevice.updateOne(
        { agentId: session.agentId, deviceId: session.deviceId, socketId },
        { $set: { online: false, lastSeen: new Date() }, $unset: { socketId: 1 } }
      );
    }
  }

  getSession(socketId: string): SocketSession | undefined {
    return this.bySocket.get(socketId);
  }

  /** Returns the currently connected Android calling device for an agent, if any. */
  getAndroidForAgent(agentId: string): SocketSession | null {
    const devices = this.androidByAgent.get(agentId);
    if (!devices || devices.size === 0) return null;
    const [, socketId] = [...devices.entries()][0];
    return this.bySocket.get(socketId) ?? null;
  }

  getWindowsSockets(agentId: string): string[] {
    return [...(this.windowsByAgent.get(agentId) ?? [])];
  }

  touch(agentId: string, deviceId: string) {
    void AgentDevice.updateOne(
      { agentId, deviceId },
      { $set: { lastSeen: new Date(), online: true } }
    );
  }
}

export const remoteCallPresence = new RemoteCallPresence();
