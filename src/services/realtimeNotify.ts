import { Server } from 'socket.io';
import { remoteCallPresence } from './remoteCallPresence';
import { remoteCallHttpHub } from './remoteCallHttpHub';
import { broadcastToAgent as broadcastCallSession } from './callSessionHub';

let ioRef: Server | null = null;

export function setSocketServer(io: Server) {
  ioRef = io;
}

export function getSocketServer(): Server | null {
  return ioRef;
}

export interface RecordingReadyPayload {
  recordingId: string;
  leadId: string;
  agentId: string;
  phoneNumber: string;
  clientCallId?: string | null;
  callStartTime: string;
  callEndTime: string;
  durationSeconds: number;
}

/** Notify Windows (and any agent sockets) that a recording is ready to play. */
export function notifyRecordingReady(payload: RecordingReadyPayload) {
  const { agentId } = payload;

  // Socket.IO (primary for Flutter apps).
  const io = ioRef;
  if (io) {
    io.to(`agent:${agentId}`).emit('recording:ready', payload);
    for (const sid of remoteCallPresence.getWindowsSockets(agentId)) {
      io.to(sid).emit('recording:ready', payload);
    }
    const android = remoteCallPresence.getAndroidForAgent(agentId);
    if (android) {
      io.to(android.socketId).emit('recording:ready', payload);
    }
  }

  // SSE fallbacks (call-sessions + remote-calls HTTP hub).
  broadcastCallSession(agentId, 'recording_ready', payload);
  remoteCallHttpHub.broadcastEvent(agentId, 'recording:ready', { ...payload });
}
