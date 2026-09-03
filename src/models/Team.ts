import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export interface ITeam extends Document {
  name: string;
  teamLeaderId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const teamSchema = new Schema<ITeam>(
  {
    name: { type: String, required: true, trim: true },
    teamLeaderId: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const Team: Model<ITeam> =
  mongoose.models.Team || mongoose.model<ITeam>('Team', teamSchema);
