import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export const REMOTE_CALL_STATUSES = [
  'pending',
  'initiated',
  'dialing',
  'ringing',
  'active',
  'ended',
  'busy',
  'rejected',
  'failed',
  'no_answer',
] as const;

export type RemoteCallStatus = (typeof REMOTE_CALL_STATUSES)[number];

export interface IRemoteCall extends Document {
  callId: string;
  leadId: Types.ObjectId;
  customerId?: string;
  agentId: Types.ObjectId;
  phoneNumber: string;
  deviceId?: string;
  status: RemoteCallStatus;
  startTime: Date;
  answerTime?: Date;
  endTime?: Date;
  durationSeconds: number;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const remoteCallSchema = new Schema<IRemoteCall>(
  {
    callId: { type: String, required: true, unique: true, index: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    customerId: { type: String },
    agentId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    phoneNumber: { type: String, required: true },
    deviceId: { type: String },
    status: { type: String, enum: REMOTE_CALL_STATUSES, default: 'pending', required: true },
    startTime: { type: Date, required: true, default: Date.now },
    answerTime: { type: Date },
    endTime: { type: Date },
    durationSeconds: { type: Number, default: 0 },
    lastError: { type: String },
  },
  { timestamps: true }
);

remoteCallSchema.index({ agentId: 1, createdAt: -1 });
remoteCallSchema.index({ agentId: 1, startTime: -1 });
remoteCallSchema.index({ leadId: 1, createdAt: -1 });

export const RemoteCall: Model<IRemoteCall> =
  mongoose.models.RemoteCall || mongoose.model<IRemoteCall>('RemoteCall', remoteCallSchema);
