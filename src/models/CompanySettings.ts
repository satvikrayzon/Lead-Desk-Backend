import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ICompanySettings extends Document {
  key: string;
  /** Seconds to wait after follow-up save before auto-dialing the next remaining lead. 0 = disabled. */
  autoNextCallDelaySeconds: number;
  updatedAt: Date;
  createdAt: Date;
}

const companySettingsSchema = new Schema<ICompanySettings>(
  {
    key: { type: String, required: true, unique: true, default: 'default' },
    autoNextCallDelaySeconds: { type: Number, required: true, default: 0, min: 0, max: 300 },
  },
  { timestamps: true }
);

export const CompanySettings: Model<ICompanySettings> =
  mongoose.models.CompanySettings ||
  mongoose.model<ICompanySettings>('CompanySettings', companySettingsSchema);

export async function getCompanySettings(): Promise<ICompanySettings> {
  let doc = await CompanySettings.findOne({ key: 'default' });
  if (!doc) {
    doc = await CompanySettings.create({ key: 'default', autoNextCallDelaySeconds: 0 });
  }
  return doc;
}
