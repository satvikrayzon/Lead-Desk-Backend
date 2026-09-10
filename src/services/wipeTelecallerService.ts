import mongoose from 'mongoose';
import {
  AgentDevice,
  CallRecording,
  Lead,
  LeadAssignment,
  LeadFollowUp,
  RemoteCall,
  User,
} from '../models';

export type WipeTelecallerResult = {
  user_id: string;
  name: string;
  email: string;
  follow_ups_deleted: number;
  recordings_deleted: number;
  remote_calls_deleted: number;
  devices_deleted: number;
  assignments_deleted: number;
  leads_deleted: number;
  deactivated: boolean;
};

/**
 * Remove a telecaller's activity + assignments and deactivate the account
 * so they no longer appear on / affect the live admin dashboard.
 */
export async function wipeTelecallerTestData(options: {
  userId: string;
  deleteOrphanLeads?: boolean;
}): Promise<WipeTelecallerResult> {
  const { userId, deleteOrphanLeads = true } = options;
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw new Error('Invalid user id');
  }

  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  const assignments = await LeadAssignment.find({ agentId: userId }).select('leadId');
  const leadIds = [...new Set(assignments.map((a) => a.leadId.toString()))];

  const [fu, rec, remote, devices, assignDel] = await Promise.all([
    LeadFollowUp.deleteMany({ agentId: userId }),
    CallRecording.deleteMany({ agentId: userId }),
    RemoteCall.deleteMany({ agentId: userId }),
    AgentDevice.deleteMany({ agentId: userId }),
    LeadAssignment.deleteMany({ agentId: userId }),
  ]);

  let leadsDeleted = 0;
  if (deleteOrphanLeads && leadIds.length > 0) {
    const objectIds = leadIds.map((x) => new mongoose.Types.ObjectId(x));
    const stillAssigned = await LeadAssignment.distinct('leadId', {
      leadId: { $in: objectIds },
      isActive: true,
    });
    const stillSet = new Set(stillAssigned.map((x) => x.toString()));
    const orphans = objectIds.filter((oid) => !stillSet.has(oid.toString()));
    if (orphans.length > 0) {
      await Promise.all([
        LeadFollowUp.deleteMany({ leadId: { $in: orphans } }),
        CallRecording.deleteMany({ leadId: { $in: orphans } }),
        RemoteCall.deleteMany({ leadId: { $in: orphans } }),
      ]);
      const leadDel = await Lead.deleteMany({ _id: { $in: orphans } });
      leadsDeleted = leadDel.deletedCount ?? 0;
    }
  }

  user.isActive = false;
  await user.save();

  return {
    user_id: user._id.toString(),
    name: user.name,
    email: user.email,
    follow_ups_deleted: fu.deletedCount ?? 0,
    recordings_deleted: rec.deletedCount ?? 0,
    remote_calls_deleted: remote.deletedCount ?? 0,
    devices_deleted: devices.deletedCount ?? 0,
    assignments_deleted: assignDel.deletedCount ?? 0,
    leads_deleted: leadsDeleted,
    deactivated: true,
  };
}
