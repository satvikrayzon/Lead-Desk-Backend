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

function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/[^\d+*#]/g, '');
  return cleaned.length >= 3 ? cleaned : null;
}

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
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
    return {
      ok: false,
      code: 'CALL_IN_PROGRESS',
      message: 'Another call is already in progress for this agent.',
    };
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

  if (TERMINAL.has(call.status) && status !== call.status) {
    // Allow refining generic "ended" into a specific outcome from CallLog.
    const canRefine =
      call.status === 'ended' &&
      status !== 'ended' &&
      TERMINAL.has(status);
    if (!canRefine) {
      forwardStatus(io, input.agentId, payloadBase());
      return { ok: true };
    }
  }

  const now = input.timestamp ? new Date(input.timestamp) : new Date();
  call.status = status;
  if (input.error) call.lastError = input.error;

  if (status === 'active' && !call.answerTime) {
    call.answerTime = now;
  }

  const neverConnected = status === 'busy' || status === 'rejected' || status === 'failed' || status === 'no_answer';
  if (neverConnected) {
    call.answerTime = undefined;
    call.durationSeconds = 0;
  }

  if (TERMINAL.has(status)) {
    call.endTime = now;
    if (call.answerTime && !neverConnected) {
      call.durationSeconds = Math.max(
        0,
        Math.floor((call.endTime.getTime() - call.answerTime.getTime()) / 1000)
      );
    } else if (neverConnected) {
      call.durationSeconds = 0;
    }
    if (activeCallByAgent.get(input.agentId) === call.callId) {
      activeCallByAgent.delete(input.agentId);
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
