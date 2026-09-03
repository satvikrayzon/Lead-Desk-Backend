import mongoose, { Schema, Document, Model, Types } from 'mongoose';
import { RecordingSource, UploadStatus } from '../types/enums';

export interface ICallRecording extends Document {
  leadId: Types.ObjectId;
  agentId: Types.ObjectId;
  phoneNumber: string;
  callStartTime: Date;
  callEndTime: Date;
  durationSeconds: number;
  source: RecordingSource;
  s3Bucket: string;
  s3Key: string;
  fileSizeBytes: number;
  mimeType: string;
  originalFilename?: string;
  clientCallId?: string;
  callOutcome?: string;
  uploadStatus: UploadStatus;
  createdAt: Date;
}

const callRecordingSchema = new Schema<ICallRecording>(
  {
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    agentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    phoneNumber: { type: String, required: true },
    callStartTime: { type: Date, required: true },
    callEndTime: { type: Date, required: true },
    durationSeconds: { type: Number, required: true },
    source: { type: String, enum: ['miuiNative', 'fallback'], required: true },
    s3Bucket: { type: String, required: true },
    s3Key: { type: String, required: true },
    fileSizeBytes: { type: Number, required: true },
    mimeType: { type: String, required: true },
    originalFilename: { type: String },
    clientCallId: { type: String },
    callOutcome: { type: String, default: 'received' },
    uploadStatus: { type: String, enum: ['uploaded', 'failed'], default: 'uploaded' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

callRecordingSchema.index({ leadId: 1, callStartTime: -1 });
callRecordingSchema.index({ agentId: 1, createdAt: -1 });
callRecordingSchema.index(
  { agentId: 1, leadId: 1, callStartTime: 1, phoneNumber: 1 },
  { unique: true }
);
callRecordingSchema.index({ clientCallId: 1 }, { sparse: true });

export const CallRecording: Model<ICallRecording> =
  mongoose.models.CallRecording ||
  mongoose.model<ICallRecording>('CallRecording', callRecordingSchema);
