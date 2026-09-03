import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export interface ILeadAssignment extends Document {
  leadId: Types.ObjectId;
  agentId: Types.ObjectId;
  assignedAt: Date;
  assignedBy?: Types.ObjectId;
  isActive: boolean;
}

const leadAssignmentSchema = new Schema<ILeadAssignment>(
  {
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    agentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    assignedAt: { type: Date, default: Date.now },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: false }
);

leadAssignmentSchema.index({ agentId: 1, isActive: 1 });

export const LeadAssignment: Model<ILeadAssignment> =
  mongoose.models.LeadAssignment ||
  mongoose.model<ILeadAssignment>('LeadAssignment', leadAssignmentSchema);
