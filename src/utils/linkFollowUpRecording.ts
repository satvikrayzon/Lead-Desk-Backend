import { Types } from 'mongoose';
import { LeadFollowUp } from '../models';

/** Attach a server recording to any follow-up waiting on this device call id. */
export async function linkFollowUpsToRecording(
  clientCallId: string,
  recordingId: Types.ObjectId
): Promise<void> {
  await LeadFollowUp.updateMany(
    {
      clientCallId,
      $or: [{ callRecordingId: { $exists: false } }, { callRecordingId: null }],
    },
    { $set: { callRecordingId: recordingId } }
  );
}
