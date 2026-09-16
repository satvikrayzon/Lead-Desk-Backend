import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';
import { Lead, LeadAssignment } from '../models';
import { RemoteCall, RemoteCallStatus, REMOTE_CALL_STATUSES } from '../models/RemoteCall';
import { remoteCallPresence } from './remoteCallPresence';
import { remoteCallHttpHub } from './remoteCallHttpHub';

const TERMINAL: Set<RemoteCallStatus> = new Set([
  'ended',
  'busy',
  'rejected',
  'failed',
  'no_answer',
]);

const activeCallByAgent = new Map<string, string>();
const seenCallIds = new Set<string>();

/** If a call stays non-terminal this long, treat the agent lock as stale. */
const STALE_ACTIVE_CALL_MS = 3 * 60 * 1000;

function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/[^\d+*#]/g, '');
  return cleaned.length >= 3 ? cleaned : null;
}

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

/** Clear in-memory active-call lock for an agent (and optionally a specific call). */
export function clearAgentActiveCall(agentId: string, callId?: string): void {
  if (!agentId) return;
  if (callId) {
    if (activeCallByAgent.get(agentId) === callId) {
      activeCallByAgent.delete(agentId);
    }
    return;
  }
  activeCallByAgent.delete(agentId);
}

/**
 * If the agent still has a lock but the DB call is already terminal / missing / too old,
 * drop the lock so the telecaller can dial again.
 */
async function releaseStaleAgentLock(agentId: string): Promise<boolean> {
  const lockedCallId = activeCallByAgent.get(agentId);
  if (!lockedCallId) return false;

  const call = await RemoteCall.findOne({ callId: lockedCallId, agentId }).lean();
  if (!call) {
    activeCallByAgent.delete(agentId);
    return true;
  }

  if (TERMINAL.has(call.status as RemoteCallStatus)) {
    activeCallByAgent.delete(agentId);
    return true;
  }

  const startedAt = call.startTime ? new Date(call.startTime).getTime() : 0;
  const ageMs = Date.now() - startedAt;
  const status = call.status as RemoteCallStatus;
  const neverLeftQueue = status === 'pending' || status === 'initiated';
  const staleSoon = neverLeftQueue && ageMs >= 45_000;
  const staleHard = ageMs >= STALE_ACTIVE_CALL_MS;

  if (staleSoon || staleHard) {
    activeCallByAgent.delete(agentId);
    // Mark the orphaned call ended so dashboards/history stay consistent.
    await RemoteCall.updateOne(
      { _id: call._id, status: { $nin: [...TERMINAL] } },
      {
        $set: {
          status: 'failed',
          endTime: new Date(),
          lastError: 'Stale call lock cleared (no terminal status received).',
        },
      }
    );
    return true;
  }

  return false;
}

export type InitiateResult =
  | {
      ok: true;
      callId: string;
      phoneNumber: string;
      leadId: string;
      timestamp: string;
    }
  | {
      ok: false;
      code:
        | 'ANDROID_DEVICE_OFFLINE'
        | 'INVALID_PAYLOAD'
        | 'LEAD_NOT_FOUND'
        | 'FORBIDDEN'
        | 'CALL_IN_PROGRESS'
        | 'DUPLICATE_CALL'
        | 'INVALID_PHONE';
      message: string;
    };

export async function initiateRemoteCall(
  io: Server | null,
  input: {
    agentId: string;
    callId?: string;
    leadId: string;
    customerId?: string;
    phoneNumber?: string;
  }
): Promise<InitiateResult> {
  if (!input.leadId || !isValidObjectId(input.leadId)) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: 'leadId is required.' };
  }

  const hasHttp = remoteCallHttpHub.hasAndroidStream(input.agentId);
  const hasSock = !!remoteCallPresence.getAndroidForAgent(input.agentId);
  if (!hasHttp && !hasSock) {
    return {
      ok: false,
      code: 'ANDROID_DEVICE_OFFLINE',
      message: 'Android calling device is offline.',
    };
  }

  if (activeCallByAgent.has(input.agentId)) {
    const released = await releaseStaleAgentLock(input.agentId);
    if (!released && activeCallByAgent.has(input.agentId)) {
      return {
        ok: false,
        code: 'CALL_IN_PROGRESS',
        message: 'Another call is already in progress for this agent.',
      };
    }
  }

  const callId = (input.callId && input.callId.trim()) || uuidv4();
  if (seenCallIds.has(callId)) {
    return { ok: false, code: 'DUPLICATE_CALL', message: 'This callId was already used.' };
  }

  const lead = await Lead.findById(input.leadId);
  if (!lead) {
    return { ok: false, code: 'LEAD_NOT_FOUND', message: 'Lead not found.' };
  }

  const assignment = await LeadAssignment.findOne({
    leadId: lead._id,
    agentId: input.agentId,
    isActive: true,
  });
  if (!assignment) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: 'You do not have permission to call this lead.',
    };
  }

  const serverPhone = normalizePhone(lead.contactMobile || lead.phoneNumber);
  const clientPhone = normalizePhone(input.phoneNumber);
  const phoneNumber = serverPhone || clientPhone;
  if (!phoneNumber) {
    return { ok: false, code: 'INVALID_PHONE', message: 'Lead has no valid phone number.' };
  }

  const finalPhone = serverPhone ?? phoneNumber;
  const deviceId =
    remoteCallHttpHub.isAndroidOnline(input.agentId).deviceId ||
    remoteCallPresence.getAndroidForAgent(input.agentId)?.deviceId;

  seenCallIds.add(callId);
  activeCallByAgent.set(input.agentId, callId);

  const now = new Date();
  await RemoteCall.create({
    callId,
    leadId: lead._id,
    customerId: input.customerId || lead.vendorId || lead.leadCode || undefined,
    agentId: input.agentId,
    phoneNumber: finalPhone,
    deviceId,
    status: 'pending',
    startTime: now,
    durationSeconds: 0,
  });

  const timestamp = now.toISOString();
  const requestPayload = {
    callId,
    leadId: lead._id.toString(),
    phoneNumber: finalPhone,
    customerId: input.customerId || null,
    timestamp,
  };

  // Prefer HTTP/SSE (works through nginx). Also emit on Socket.IO if present.
  remoteCallHttpHub.sendToAndroid(input.agentId, 'call:request', requestPayload);
  const sockAndroid = remoteCallPresence.getAndroidForAgent(input.agentId);
  if (io && sockAndroid) {
    io.to(sockAndroid.socketId).emit('call:request', requestPayload);
  }

  return {
    ok: true,
    callId,
    phoneNumber: finalPhone,
    leadId: lead._id.toString(),
    timestamp,
  };
}

export async function applyCallStatus(
  io: Server | null,
  input: {
    agentId: string;
    callId: string;
    status: string;
    timestamp?: string;
    error?: string;
    /** Authoritative talk seconds from Android CallLog DURATION when available. */
    durationSeconds?: number;
  }
): Promise<{ ok: boolean; message?: string }> {
  if (!input.callId || !REMOTE_CALL_STATUSES.includes(input.status as RemoteCallStatus)) {
    return { ok: false, message: 'Invalid call status payload.' };
  }

  const status = input.status as RemoteCallStatus;
  const call = await RemoteCall.findOne({ callId: input.callId, agentId: input.agentId });
  if (!call) {
    return { ok: false, message: 'Call not found.' };
  }

  const payloadBase = () => ({
    callId: call.callId,
    status: call.status,
    timestamp: (call.endTime || new Date()).toISOString(),
    durationSeconds: call.durationSeconds,
    answerTime: call.answerTime?.toISOString() ?? null,
    endTime: call.endTime?.toISOString() ?? null,
    error: call.lastError ?? null,
  });

  const clientDuration =
    typeof input.durationSeconds === 'number' &&
    Number.isFinite(input.durationSeconds) &&
    input.durationSeconds >= 0
      ? Math.floor(input.durationSeconds)
      : undefined;

  const neverConnectedStatus = (s: string) =>
    s === 'busy' || s === 'rejected' || s === 'failed' || s === 'no_answer';

  // Already terminal: patch late CallLog talk time and/or refine ended → busy/etc.
  if (TERMINAL.has(call.status)) {
    const canRefine =
      call.status === 'ended' && status !== 'ended' && TERMINAL.has(status);

    if (status === call.status || (status === 'ended' && call.status === 'ended')) {
      if (clientDuration !== undefined && !neverConnectedStatus(call.status)) {
        // CallLog DURATION is authoritative over end−answer estimates.
        call.durationSeconds = clientDuration;
        if (clientDuration > 0 && !call.answerTime) {
          const end = call.endTime || new Date();
          call.answerTime = new Date(end.getTime() - clientDuration * 1000);
        }
        await call.save();
      }
      forwardStatus(io, input.agentId, payloadBase());
      return { ok: true };
    }

    if (!canRefine) {
      forwardStatus(io, input.agentId, payloadBase());
      return { ok: true };
    }
    // Fall through to refine outcome (e.g. ended → no_answer).
  }

  const now = input.timestamp ? new Date(input.timestamp) : new Date();
  const previousStatus = call.status;
  call.status = status;
  if (input.error) call.lastError = input.error;

  if (status === 'active' && !call.answerTime) {
    call.answerTime = now;
  }

  const neverConnected = neverConnectedStatus(status);
  if (neverConnected) {
    call.answerTime = undefined;
    call.durationSeconds = 0;
  }

  if (TERMINAL.has(status)) {
    call.endTime = now;
    if (neverConnected) {
      call.durationSeconds = 0;
    } else if (clientDuration !== undefined) {
      // Prefer Android CallLog DURATION over end−answer wall clock.
      call.durationSeconds = clientDuration;
      if (clientDuration > 0 && !call.answerTime) {
        call.answerTime = new Date(now.getTime() - clientDuration * 1000);
      }
    } else if (call.answerTime) {
      call.durationSeconds = Math.max(
        0,
        Math.floor((call.endTime.getTime() - call.answerTime.getTime()) / 1000)
      );
    }
    // else: ended without answerTime and no CallLog duration → leave prior value (usually 0)
    if (activeCallByAgent.get(input.agentId) === call.callId) {
      activeCallByAgent.delete(input.agentId);
    }

    // First time this remote call ends → count it on the lead (Windows CRM has no local call DB).
    // Includes not-connected outcomes (busy / no_answer / rejected / failed).
    if (!TERMINAL.has(previousStatus)) {
      await Lead.findByIdAndUpdate(call.leadId, {
        $inc: { callCount: 1 },
        $set: { lastCalledAt: call.endTime, lastContactDate: call.endTime },
      });
      await LeadAssignment.updateMany(
        { leadId: call.leadId, isActive: true },
        {
          $inc: { callCount: 1 },
          $set: { lastCalledAt: call.endTime, listSyncedAt: new Date() },
        }
      );
    }
  }

  await call.save();

  forwardStatus(io, input.agentId, {
    callId: call.callId,
    status: call.status,
    timestamp: now.toISOString(),
    durationSeconds: call.durationSeconds,
    answerTime: call.answerTime?.toISOString() ?? null,
    endTime: call.endTime?.toISOString() ?? null,
    error: call.lastError ?? null,
  });

  return { ok: true };
}

export async function endRemoteCall(
  io: Server | null,
  input: { agentId: string; callId: string }
): Promise<{ ok: boolean; code?: string; message?: string }> {
  if (!input.callId) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: 'callId is required.' };
  }

  const call = await RemoteCall.findOne({ callId: input.callId, agentId: input.agentId });
  if (!call) {
    return { ok: false, code: 'NOT_FOUND', message: 'Call not found.' };
  }

  if (TERMINAL.has(call.status)) {
    return { ok: true };
  }

  const endPayload = {
    callId: input.callId,
    timestamp: new Date().toISOString(),
  };

  const deliveredHttp = remoteCallHttpHub.sendToAndroid(input.agentId, 'call:end', endPayload);
  const sockAndroid = remoteCallPresence.getAndroidForAgent(input.agentId);
  if (io && sockAndroid) {
    io.to(sockAndroid.socketId).emit('call:end', endPayload);
  }

  if (!deliveredHttp && !sockAndroid) {
    await applyCallStatus(io, {
      agentId: input.agentId,
      callId: input.callId,
      status: 'ended',
    });
    return { ok: true, message: 'Android offline; call marked ended.' };
  }

  return { ok: true };
}

function forwardStatus(io: Server | null, agentId: string, payload: Record<string, unknown>) {
  remoteCallHttpHub.broadcastStatus(agentId, payload);

  if (!io) return;
  for (const socketId of remoteCallPresence.getWindowsSockets(agentId)) {
    io.to(socketId).emit('call:status', payload);
  }
  const android = remoteCallPresence.getAndroidForAgent(agentId);
  if (android) {
    io.to(android.socketId).emit('call:status', payload);
  }
}

export function clearActiveCall(agentId: string, callId: string) {
  if (activeCallByAgent.get(agentId) === callId) {
    activeCallByAgent.delete(agentId);
  }
}
