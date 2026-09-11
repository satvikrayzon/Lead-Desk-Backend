import mongoose from 'mongoose';
import { env } from './env';
import { CallRecording, LeadFollowUp, RemoteCall } from '../models';

export async function connectDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  await mongoose.connect(env.MONGODB_URI);
  // Ensure dashboard query indexes exist (agentId + time) — missing indexes were 30–40s scans.
  void Promise.all([
    RemoteCall.syncIndexes(),
    LeadFollowUp.syncIndexes(),
    CallRecording.syncIndexes(),
  ]).catch((err) => {
    console.warn('[db] syncIndexes warning', err instanceof Error ? err.message : err);
  });
}

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
