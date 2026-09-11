import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export interface ILeadAssignment extends Document {
  leadId: Types.ObjectId;
  agentId: Types.ObjectId;
  assignedAt: Date;
  assignedBy?: Types.ObjectId;
  isActive: boolean;
  /** Denormalized from Lead so All Leads can paginate without loading 6k leads. */
  callCount: number;
  lastCalledAt?: Date | null;
  importRowNumber: number;
  nextFollowupDate?: Date | null;
  state?: string | null;
  district?: string | null;
  city?: string | null;
  leadStatus?: string | null;
  leadStage?: string | null;
  priority?: string | null;
  customerType?: string | null;
  product?: string | null;
  companyName?: string | null;
  contactPerson?: string | null;
  contactMobile?: string | null;
  leadCode?: string | null;
  listSyncedAt?: Date | null;
}

const leadAssignmentSchema = new Schema<ILeadAssignment>(
  {
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    agentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    assignedAt: { type: Date, default: Date.now },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    isActive: { type: Boolean, default: true },
    callCount: { type: Number, default: 0, index: true },
    lastCalledAt: { type: Date, default: null },
    importRowNumber: { type: Number, default: 999999999 },
    nextFollowupDate: { type: Date, default: null },
    state: { type: String, default: null },
    district: { type: String, default: null },
    city: { type: String, default: null },
    leadStatus: { type: String, default: null },
    leadStage: { type: String, default: null },
    priority: { type: String, default: null },
    customerType: { type: String, default: null },
    product: { type: String, default: null },
    companyName: { type: String, default: null },
    contactPerson: { type: String, default: null },
    contactMobile: { type: String, default: null },
    leadCode: { type: String, default: null },
    listSyncedAt: { type: Date, default: null },
  },
  { timestamps: false }
);

leadAssignmentSchema.index({ agentId: 1, isActive: 1 });
leadAssignmentSchema.index({ agentId: 1, isActive: 1, assignedAt: -1 });
leadAssignmentSchema.index({ leadId: 1, agentId: 1, isActive: 1 });
leadAssignmentSchema.index({ isActive: 1, agentId: 1 });
leadAssignmentSchema.index({ isActive: 1, callCount: 1, importRowNumber: 1, assignedAt: 1 });
leadAssignmentSchema.index({ isActive: 1, callCount: 1, lastCalledAt: -1 });
leadAssignmentSchema.index({ isActive: 1, agentId: 1, callCount: 1, importRowNumber: 1, assignedAt: 1 });
leadAssignmentSchema.index({ isActive: 1, agentId: 1, callCount: 1, lastCalledAt: -1 });
leadAssignmentSchema.index({ isActive: 1, listSyncedAt: 1 });

export const LeadAssignment: Model<ILeadAssignment> =
  mongoose.models.LeadAssignment ||
  mongoose.model<ILeadAssignment>('LeadAssignment', leadAssignmentSchema);
