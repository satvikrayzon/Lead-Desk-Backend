import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ImportErrorRow {
  row: number;
  message: string;
}

export interface ILeadImportBatch extends Document {
  uploadedByUserId?: mongoose.Types.ObjectId;
  originalFilename?: string;
  totalRows: number;
  createdCount: number;
  skippedCount: number;
  errorCount: number;
  rowErrors: ImportErrorRow[];
  createdAt: Date;
  updatedAt: Date;
}

const leadImportBatchSchema = new Schema<ILeadImportBatch>(
  {
    uploadedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    originalFilename: { type: String },
    totalRows: { type: Number, default: 0 },
    createdCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },
    rowErrors: { type: [{ row: Number, message: String }], default: [] },
  },
  { timestamps: true },
);

export const LeadImportBatch: Model<ILeadImportBatch> =
  mongoose.models.LeadImportBatch ||
  mongoose.model<ILeadImportBatch>('LeadImportBatch', leadImportBatchSchema);
