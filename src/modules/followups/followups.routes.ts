import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { CallRecording, Lead, LeadFollowUp } from '../../models';
import { AuthRequest } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import { isLeadAssignedToAgent, createAuditLog, parseOptionalCalendarDate } from '../../utils/helpers';
import { isSundayIst } from '../../utils/istCalendar';
import { formatFollowUp } from '../../utils/followUpFormat';
import { ILeadFollowUp } from '../../models/LeadFollowUp';
import { ILead } from '../../models/Lead';

export const followUpsRouter = Router();

const createFollowUpSchema = z.object({
  remarks: z.string().min(1),
  client_call_id: z.string().min(1),
  call_recording_id: z.string().optional(),
  call_outcome: z.string().optional(),
  lead_result: z.string().optional(),
  next_followup_date: z.union([z.string(), z.null()]).optional(),
  /** Client-measured seconds from form open to save (0–7200). */
  form_fill_seconds: z.number().int().min(0).max(7200).optional(),
});

function assertFollowUpDateNotSunday(date: Date | undefined | null) {
  if (!date) return;
  if (isSundayIst(date)) {
    throw new AppError(400, 'Follow-up cannot be set on Sunday. Please choose another day.');
  }
}

/** Scheduled follow-ups across all leads for the logged-in agent. */
followUpsRouter.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const scheduledOnly = req.query.scheduled === 'true';

    const filter: Record<string, unknown> = { agentId: userId };
    if (scheduledOnly) {
      filter.nextFollowupDate = { $ne: null };
    }

    const followUps = await LeadFollowUp.find(filter)
      .sort({ nextFollowupDate: 1, createdAt: -1 })
      .limit(5000);

    const leadIds = [...new Set(followUps.map((f) => f.leadId.toString()))];
    const recordingIds = followUps
      .map((f) => f.callRecordingId?.toString())
      .filter((id): id is string => Boolean(id));

    const [leads, recordings] = await Promise.all([
      Lead.find({ _id: { $in: leadIds } }),
      recordingIds.length > 0 ? CallRecording.find({ _id: { $in: recordingIds } }) : [],
    ]);

    const leadById = new Map(leads.map((l) => [l._id.toString(), l]));
    const recordingById = new Map(recordings.map((r) => [r._id.toString(), r]));

    const data = await Promise.all(
      followUps.map((f) =>
        formatFollowUp(
          f,
          leadById.get(f.leadId.toString()),
          f.callRecordingId ? recordingById.get(f.callRecordingId.toString()) : null
        )
      )
    );

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

/** Create or update a follow-up tied to one call recording. */
export async function upsertLeadFollowUp(params: {
  leadId: string;
  userId: string;
  body: z.infer<typeof createFollowUpSchema>;
  ipAddress?: string;
}) {
  const { leadId, userId, body, ipAddress } = params;
  const remarks = body.remarks.trim();
  if (!remarks) throw new AppError(400, 'Follow-up remarks are required.');

  const lead = await Lead.findById(leadId);
  if (!lead) throw new AppError(404, 'Lead not found.');

  const assigned = await isLeadAssignedToAgent(leadId, userId);
  if (!assigned) throw new AppError(403, 'You do not have access to this lead.');

  let callRecordingId: string | undefined;
  if (body.call_recording_id) {
    const recording = await CallRecording.findById(body.call_recording_id);
    if (!recording || recording.leadId.toString() !== leadId) {
      throw new AppError(400, 'Invalid call recording for this lead.');
    }
    if (recording.agentId.toString() !== userId) {
      throw new AppError(403, 'You do not have access to this recording.');
    }
    callRecordingId = recording._id.toString();
  } else {
    const byClient = await CallRecording.findOne({ clientCallId: body.client_call_id });
    if (byClient && byClient.leadId.toString() === leadId) {
      callRecordingId = byClient._id.toString();
    }
  }

  const nextFollowupDate = parseOptionalCalendarDate(body.next_followup_date);
  assertFollowUpDateNotSunday(nextFollowupDate);
  const callOutcome = body.call_outcome?.trim() || 'unknown';
  const leadResult = body.lead_result?.trim() || undefined;
  const formFillSeconds =
    typeof body.form_fill_seconds === 'number' ? body.form_fill_seconds : undefined;

  const existing = await LeadFollowUp.findOne({ clientCallId: body.client_call_id });

  let followUp: ILeadFollowUp;
  if (existing) {
    existing.remarks = remarks;
    existing.nextFollowupDate = nextFollowupDate ?? undefined;
    existing.callOutcome = callOutcome;
    if (leadResult !== undefined) existing.leadResult = leadResult || undefined;
    if (formFillSeconds !== undefined) existing.formFillSeconds = formFillSeconds;
    if (callRecordingId) existing.callRecordingId = callRecordingId as unknown as ILeadFollowUp['callRecordingId'];
    await existing.save();
    followUp = existing;
  } else {
    // Only the latest follow-up should carry a scheduled next date.
    await LeadFollowUp.updateMany({ leadId }, { $unset: { nextFollowupDate: '' } });

    const sequenceNumber = (await LeadFollowUp.countDocuments({ leadId })) + 1;
    followUp = await LeadFollowUp.create({
      leadId,
      agentId: userId,
      clientCallId: body.client_call_id,
      remarks,
      callOutcome,
      ...(leadResult ? { leadResult } : {}),
      nextFollowupDate: nextFollowupDate ?? undefined,
      ...(formFillSeconds !== undefined ? { formFillSeconds } : {}),
      ...(callRecordingId ? { callRecordingId } : {}),
      sequenceNumber,
    });
  }

  await syncLeadLegacyFollowUpFields(leadId);

  let recording = callRecordingId ? await CallRecording.findById(callRecordingId) : null;
  if (!recording && followUp.callRecordingId) {
    recording = await CallRecording.findById(followUp.callRecordingId);
  }

  await createAuditLog({
    userId,
    action: 'lead.followup.created',
    entityType: 'lead_follow_up',
    entityId: followUp._id.toString(),
    metadata: { leadId, clientCallId: body.client_call_id },
    ipAddress,
  });

  return formatFollowUp(followUp, lead, recording);
}

/** Mirrors chained follow-ups onto legacy lead columns used by older exports/reports.
 * Uses $set on FU fields only so concurrent city/contact PATCHes are never overwritten.
 */
export async function syncLeadLegacyFollowUpFields(leadId: string): Promise<void> {
  const followUps = await LeadFollowUp.find({ leadId }).sort({ sequenceNumber: 1, createdAt: 1 });
  const bySeq = (n: number) => followUps.find((f) => (f.sequenceNumber ?? 0) === n);

  const f1 = bySeq(1);
  const f2 = bySeq(2);
  const f3 = bySeq(3);
  const latest = followUps.length > 0 ? followUps[followUps.length - 1] : null;
  const scheduled = [...followUps].reverse().find((f) => f.nextFollowupDate);

  const $set: Record<string, unknown> = {
    followup2: f2?.remarks,
    followup2Date: f2?.createdAt,
    followup3: f3?.remarks,
    followup3Date: f3?.createdAt,
  };
  const $unset: Record<string, 1> = {};

  if (scheduled?.nextFollowupDate) {
    $set.nextFollowupDate = scheduled.nextFollowupDate;
  } else {
    $unset.nextFollowupDate = 1;
  }

  if (f1) $set.followupRemarks = f1.remarks;
  else if (latest) $set.followupRemarks = latest.remarks;

  if (latest) $set.lastContactDate = latest.createdAt;

  const dialFollowUps = followUps.filter((f) => {
    const o = (f.callOutcome || '').trim().toLowerCase();
    return Boolean(f.clientCallId) || (o.length > 0 && o !== 'unknown');
  });
  if (dialFollowUps.length > 0) {
    const latestDial = dialFollowUps[dialFollowUps.length - 1];
    $set.callCount = dialFollowUps.length;
    if (latestDial.createdAt) $set.lastCalledAt = latestDial.createdAt;
  }

  const withFill = followUps.filter(
    (f) => typeof f.formFillSeconds === 'number' && (f.formFillSeconds as number) >= 0
  );
  if (withFill.length > 0) {
    const last = withFill[withFill.length - 1];
    $set.lastFormFillSeconds = last.formFillSeconds;
    const sum = withFill.reduce((acc, f) => acc + (f.formFillSeconds ?? 0), 0);
    $set.avgFormFillSeconds = Math.round(sum / withFill.length);
  }

  // Max callCount with existing value without loading full doc into a save race.
  if ($set.callCount != null) {
    const existing = await Lead.findById(leadId).select('callCount lastCalledAt').lean();
    if (existing) {
      $set.callCount = Math.max(existing.callCount ?? 0, $set.callCount as number);
      if (
        existing.lastCalledAt &&
        $set.lastCalledAt instanceof Date &&
        existing.lastCalledAt > $set.lastCalledAt
      ) {
        $set.lastCalledAt = existing.lastCalledAt;
      }
    }
  }

  // Drop undefined keys so Mongo doesn't null them out.
  for (const key of Object.keys($set)) {
    if ($set[key] === undefined) delete $set[key];
  }

  const update: Record<string, unknown> = {};
  if (Object.keys($set).length) update.$set = $set;
  if (Object.keys($unset).length) update.$unset = $unset;
  if (Object.keys(update).length) {
    await Lead.updateOne({ _id: leadId }, update);
  }
}

followUpsRouter.post('/leads/:leadId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = createFollowUpSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues.map((i) => i.message).join('; '));
    }

    const data = await upsertLeadFollowUp({
      leadId: req.params.leadId as string,
      userId: req.user!.id,
      body: parsed.data,
      ipAddress: req.ip,
    });

    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

/** All follow-ups for one lead (newest first). */
followUpsRouter.get('/leads/:leadId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const userRole = req.user!.role;
    const leadId = req.params.leadId as string;

    const lead = await Lead.findById(leadId);
    if (!lead) throw new AppError(404, 'Lead not found.');

    if (userRole === 'agent') {
      const assigned = await isLeadAssignedToAgent(leadId, userId);
      if (!assigned) throw new AppError(403, 'You do not have access to this lead.');
    }

    const followUps = await LeadFollowUp.find({ leadId }).sort({ sequenceNumber: -1, createdAt: -1 });
    const recordingIds = followUps
      .map((f) => f.callRecordingId?.toString())
      .filter((id): id is string => Boolean(id));

    const recordings = recordingIds.length > 0 ? await CallRecording.find({ _id: { $in: recordingIds } }) : [];
    const recordingById = new Map(recordings.map((r) => [r._id.toString(), r]));

    const data = await Promise.all(
      followUps.map((f) =>
        formatFollowUp(
          f,
          lead as ILead,
          f.callRecordingId ? recordingById.get(f.callRecordingId.toString()) : null
        )
      )
    );

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

export { createFollowUpSchema };
