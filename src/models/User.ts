import mongoose, { Schema, Document, Model } from 'mongoose';
import { UserRole } from '../types/enums';

export interface IUser extends Document {
  name: string;
  email: string;
  username?: string;
  passwordHash: string;
  phone?: string;
  role: UserRole;
  teamId?: mongoose.Types.ObjectId;
  teamName?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    username: { type: String, unique: true, sparse: true, trim: true },
    passwordHash: { type: String, required: true },
    phone: { type: String },
    role: { type: String, enum: ['agent', 'manager', 'admin'], default: 'agent' },
    teamId: { type: Schema.Types.ObjectId, ref: 'Team' },
    teamName: { type: String },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const User: Model<IUser> =
  mongoose.models.User || mongoose.model<IUser>('User', userSchema);
