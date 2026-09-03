import mongoose from 'mongoose';
import { env } from './env';

export async function connectDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  await mongoose.connect(env.MONGODB_URI);
}

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
