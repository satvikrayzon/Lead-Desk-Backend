import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export interface ILeadFollowUp extends Document {
  leadId: Types.ObjectId;
  agentId: Types.ObjectId;
  callRecordingId?: Types.ObjectId;
  clientCallId: string;
  remarks: string;
  nextFollowupDate?: Date;
  callOutcome?: string;
  sequenceNumber: number;
  createdAt: Date;
  updatedAt: Date;
}

const leadFollowUpSchema = new Schema<ILeadFollowUp>(
  {
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    agentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    callRecordingId: { type: Schema.Types.ObjectId, ref: 'CallRecording' },
    clientCallId: { type: String, required: true },
    remarks: { type: String, required: true },
    nextFollowupDate: { type: Date },
    callOutcome: { type: String, default: 'unknown' },
    sequenceNumber: { type: Number, required: true },
  },
  { timestamps: true }
);

leadFollowUpSchema.index({ leadId: 1, createdAt: -1 });
leadFollowUpSchema.index({ agentId: 1, nextFollowupDate: 1 });
leadFollowUpSchema.index({ clientCallId: 1 }, { unique: true });
leadFollowUpSchema.index({ callRecordingId: 1 }, { sparse: true, unique: true });

export const LeadFollowUp: Model<ILeadFollowUp> =
  mongoose.models.LeadFollowUp ||
  mongoose.model<ILeadFollowUp>('LeadFollowUp', leadFollowUpSchema);
