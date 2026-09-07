import { env } from '../config/env';
import { getPresignedUrl } from '../config/s3';
import { ICallRecording } from '../models/CallRecording';
import { ILead } from '../models/Lead';
import { ILeadFollowUp } from '../models/LeadFollowUp';

export interface FollowUpCallPayload {
  id: string;
  phone_number: string;
  call_start_time: string;
  call_end_time: string;
  duration_seconds: number;
  recording_url: string | null;
}

export interface FollowUpResponse {
  id: string;
  lead_id: string;
  lead_company_name: string | null;
  lead_contact_mobile: string | null;
  agent_id: string;
  client_call_id: string;
  call_recording_id: string | null;
  call_outcome: string;
  remarks: string;
  next_followup_date: string | null;
  form_fill_seconds: number | null;
  sequence_number: number;
  created_at: string;
  call: FollowUpCallPayload | null;
}

export async function formatRecordingPayload(
  recording: ICallRecording
): Promise<FollowUpCallPayload> {
  let recordingUrl: string | null = null;
  if (recording.uploadStatus === 'uploaded') {
    if (env.S3_ENABLED && recording.s3Bucket !== 'local') {
      const presigned = await getPresignedUrl(recording.s3Key);
      recordingUrl = presigned.url;
    } else {
      // Relative to /api — clients prepend their configured apiBaseUrl so
      // playback works even when server API_BASE_URL is an internal LAN IP.
      recordingUrl = `recordings/${recording._id.toString()}/file`;
    }
  }

  return {
    id: recording._id.toString(),
    phone_number: recording.phoneNumber,
    call_start_time: recording.callStartTime.toISOString(),
    call_end_time: recording.callEndTime.toISOString(),
    duration_seconds: recording.durationSeconds,
    recording_url: recordingUrl,
  };
}

export async function formatFollowUp(
  followUp: ILeadFollowUp,
  lead?: ILead | null,
  recording?: ICallRecording | null
): Promise<FollowUpResponse> {
  const call = recording ? await formatRecordingPayload(recording) : null;

  return {
    id: followUp._id.toString(),
    lead_id: followUp.leadId.toString(),
    lead_company_name: lead?.companyName ?? null,
    lead_contact_mobile: lead?.contactMobile ?? null,
    agent_id: followUp.agentId.toString(),
    client_call_id: followUp.clientCallId,
    call_recording_id: followUp.callRecordingId?.toString() ?? null,
    call_outcome: followUp.callOutcome ?? recording?.callOutcome ?? 'unknown',
    remarks: followUp.remarks,
    next_followup_date: followUp.nextFollowupDate?.toISOString() ?? null,
    form_fill_seconds:
      typeof followUp.formFillSeconds === 'number' ? followUp.formFillSeconds : null,
    sequence_number: followUp.sequenceNumber ?? 1,
    created_at: followUp.createdAt.toISOString(),
    call,
  };
}
