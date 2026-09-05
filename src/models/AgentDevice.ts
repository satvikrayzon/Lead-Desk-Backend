import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export type DevicePlatform = 'android' | 'windows' | 'other';

export interface IAgentDevice extends Document {
  agentId: Types.ObjectId;
  deviceId: string;
  platform: DevicePlatform;
  deviceName?: string;
  online: boolean;
  lastSeen: Date;
  socketId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const agentDeviceSchema = new Schema<IAgentDevice>(
  {
    agentId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    deviceId: { type: String, required: true },
    platform: { type: String, enum: ['android', 'windows', 'other'], required: true },
    deviceName: { type: String },
    online: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now },
    socketId: { type: String },
  },
  { timestamps: true }
);

agentDeviceSchema.index({ agentId: 1, deviceId: 1 }, { unique: true });
agentDeviceSchema.index({ agentId: 1, platform: 1, online: 1 });

export const AgentDevice: Model<IAgentDevice> =
  mongoose.models.AgentDevice || mongoose.model<IAgentDevice>('AgentDevice', agentDeviceSchema);
