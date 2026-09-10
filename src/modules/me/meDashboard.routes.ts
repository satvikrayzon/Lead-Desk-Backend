import { Router, Response, NextFunction } from 'express';
import { CallRecording, LeadAssignment, LeadFollowUp, RemoteCall, User } from '../../models';
import { ILead } from '../../models/Lead';
import { AuthRequest } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import {
  buildDailySalesReport,
  buildDailySalesReportWorkbook,
  formatDailySalesReportText,
  parseReportRange,
} from '../../services/dailySalesReportService';
import { countAgentTabTotals } from '../leads/leadListFilters';
import { dateKeyIst, daysAgoIst, startOfIstDay } from '../../utils/istCalendar';

export const meDashboardRouter = Router();

const REMOTE_TERMINAL = ['ended', 'busy', 'rejected', 'failed', 'no_answer'] as const;

type DialEvent = {
  id: string;
  leadId: string;
  phoneNumber: string;
  startTime: Date;
  endTime: Date | null;
  durationSeconds: number;
  callOutcome: string | null;
  companyName: string;
  contactPerson: string | null;
  leadCode: string | null;
  source: 'recording' | 'remote' | 'follow_up';
  clientCallId?: string | null;
};

function avgFormFill(rows: { formFillSeconds?: number }[]) {
  let sum = 0;
  let count = 0;
  for (const r of rows) {
    if (typeof r.formFillSeconds !== 'number' || r.formFillSeconds < 0) continue;
    sum += r.formFillSeconds;
    count += 1;
  }
  return {
    avg: count > 0 ? Math.round(sum / count) : 0,
    count,
  };
}

function refId(ref: unknown): string {
  if (ref == null) return '';
  if (typeof ref === 'object' && ref !== null && '_id' in (ref as object)) {
    return String((ref as { _id: unknown })._id);
  }
  return String(ref);
}

/**
 * Merge recordings + remotes + follow-up dials.
 * No-answer / busy usually have no recording — they live on the follow-up form.
 */
function mergeDials(
  recordings: Array<{
    _id: { toString(): string };
    leadId: unknown;
    phoneNumber: string;
    callStartTime: Date;
    callEndTime?: Date;
    durationSeconds?: number;
    callOutcome?: string;
    clientCallId?: string;
    lead?: {
      _id?: { toString(): string };
      companyName?: string;
      contactPerson?: string;
      leadCode?: string;
    } | null;
  }>,
  remotes: Array<{
    _id: { toString(): string };
    callId: string;
    leadId: { toString(): string };
    phoneNumber: string;
    startTime: Date;
    endTime?: Date;
    durationSeconds?: number;
    status: string;
  }>,
  followUps: Array<{
    _id: { toString(): string };
    leadId: unknown;
    clientCallId?: string;
    callRecordingId?: { toString(): string } | null;
    callOutcome?: string;
    createdAt: Date;
    phoneNumber?: string;
  }> = []
): DialEvent[] {
  const events: DialEvent[] = [];
  const countedClientIds = new Set<string>();
  const countedRecordingIds = new Set<string>();
  const dialTimesByLead = new Map<string, number[]>();

  const mark = (
    leadKey: string,
    startMs: number,
    clientId?: string | null,
    recordingId?: string | null
  ) => {
    if (clientId) countedClientIds.add(clientId);
    if (recordingId) countedRecordingIds.add(recordingId);
    if (!leadKey) return;
    const list = dialTimesByLead.get(leadKey) ?? [];
    list.push(startMs);
    dialTimesByLead.set(leadKey, list);
  };

  const near = (leadKey: string, startMs: number, windowMs = 5 * 60 * 1000) => {
    const list = dialTimesByLead.get(leadKey);
    if (!list?.length) return false;
    return list.some((t) => Math.abs(t - startMs) <= windowMs);
  };

  for (const c of recordings) {
    const lead = c.lead;
    const leadKey =
      lead?._id?.toString() ||
      (c.leadId && typeof (c.leadId as { toString?: () => string }).toString === 'function'
        ? (c.leadId as { toString(): string }).toString()
        : '');
    const startMs = new Date(c.callStartTime).getTime();
    const recId = c._id.toString();
    events.push({
      id: recId,
      leadId: leadKey,
      phoneNumber: c.phoneNumber,
      startTime: c.callStartTime,
      endTime: c.callEndTime ?? null,
      durationSeconds: Math.max(0, c.durationSeconds || 0),
      callOutcome: c.callOutcome ?? null,
      companyName: lead?.companyName ?? '—',
      contactPerson: lead?.contactPerson ?? null,
      leadCode: lead?.leadCode ?? null,
      source: 'recording',
      clientCallId: c.clientCallId,
    });
    mark(leadKey, startMs, c.clientCallId, recId);
  }

  for (const c of remotes) {
    if (c.callId && countedClientIds.has(c.callId)) continue;
    const leadKey = c.leadId?.toString() || '';
    const startMs = new Date(c.startTime).getTime();
    if (leadKey && near(leadKey, startMs)) continue;

    events.push({
      id: c._id.toString(),
      leadId: leadKey,
      phoneNumber: c.phoneNumber,
      startTime: c.startTime,
      endTime: c.endTime ?? null,
      durationSeconds: Math.max(0, c.durationSeconds || 0),
      callOutcome: c.status,
      companyName: '—',
      contactPerson: null,
      leadCode: null,
      source: 'remote',
      clientCallId: c.callId,
    });
    mark(leadKey, startMs, c.callId);
  }

  for (const f of followUps) {
    const clientId = f.clientCallId?.trim() || '';
    if (clientId && countedClientIds.has(clientId)) continue;
    if (f.callRecordingId && countedRecordingIds.has(f.callRecordingId.toString())) continue;

    const leadKey = refId(f.leadId);
    const startMs = f.createdAt ? new Date(f.createdAt).getTime() : 0;
    if (leadKey && startMs && near(leadKey, startMs)) continue;

    events.push({
      id: f._id.toString(),
      leadId: leadKey,
      phoneNumber: f.phoneNumber || '',
      startTime: f.createdAt,
      endTime: null,
      durationSeconds: 0,
      callOutcome: f.callOutcome ?? null,
      companyName: '—',
      contactPerson: null,
      leadCode: null,
      source: 'follow_up',
      clientCallId: clientId || null,
    });
    mark(leadKey, startMs || Date.now(), clientId || null);
  }

  events.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
  return events;
}

/** Logged-in telecaller / team leader personal performance dashboard. */
meDashboardRouter.get('/dashboard', async (req: AuthRequest, res: Response, next: NextFunction) => {
  const startedAt = Date.now();
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new AppError(401, 'Authentication required.');
    }

    const user = await User.findById(userId).select('name email role teamName isActive');
    if (!user) {
      throw new AppError(404, 'User not found.');
    }
    if (user.isActive === false) {
      throw new AppError(404, 'User not found.');
    }

    const todayStart = startOfIstDay();
    const weekStart = daysAgoIst(6);
    const allTimeStart = new Date(0);

    const [
      assignmentDocs,
      recordingsToday,
      recordingsWeek,
      recordingsAll,
      remotesToday,
      remotesWeek,
      remotesAll,
      followUpsTodayDocs,
      followUpsWeekDocs,
      followUpsAllDocs,
    ] = await Promise.all([
      LeadAssignment.find({ agentId: userId, isActive: true })
        .sort({ assignedAt: -1 })
        .populate<{ leadId: ILead }>('leadId'),
      CallRecording.find({ agentId: userId, callStartTime: { $gte: todayStart } })
        .select('leadId phoneNumber durationSeconds callStartTime callEndTime callOutcome clientCallId')
        .populate('leadId', 'companyName contactPerson leadCode')
        .sort({ callStartTime: -1 }),
      CallRecording.find({ agentId: userId, callStartTime: { $gte: weekStart } }).select(
        'leadId phoneNumber durationSeconds callStartTime callEndTime callOutcome clientCallId'
      ),
      CallRecording.find({ agentId: userId, callStartTime: { $gte: allTimeStart } }).select(
        '_id leadId callStartTime clientCallId'
      ),
      RemoteCall.find({
        agentId: userId,
        startTime: { $gte: todayStart },
        status: { $in: [...REMOTE_TERMINAL] },
      }).select('leadId phoneNumber durationSeconds startTime endTime status callId'),
      RemoteCall.find({
        agentId: userId,
        startTime: { $gte: weekStart },
        status: { $in: [...REMOTE_TERMINAL] },
      }).select('leadId phoneNumber durationSeconds startTime endTime status callId'),
      RemoteCall.find({
        agentId: userId,
        startTime: { $gte: allTimeStart },
        status: { $in: [...REMOTE_TERMINAL] },
      }).select('_id leadId startTime callId'),
      LeadFollowUp.find({ agentId: userId, createdAt: { $gte: todayStart } }).select(
        'leadId clientCallId callRecordingId callOutcome createdAt formFillSeconds'
      ),
      LeadFollowUp.find({ agentId: userId, createdAt: { $gte: weekStart } }).select(
        'leadId clientCallId callRecordingId callOutcome createdAt formFillSeconds'
      ),
      LeadFollowUp.find({ agentId: userId, createdAt: { $gte: allTimeStart } }).select(
        '_id leadId clientCallId callRecordingId callOutcome createdAt'
      ),
    ]);

    const populated = assignmentDocs
      .filter((a) => a.leadId)
      .map((a) => ({ leadId: a.leadId as ILead, assignedAt: a.assignedAt }));
    const { remaining: pendingLeads, called: calledLeads } = countAgentTabTotals(populated, {});

    const mapRecording = (c: (typeof recordingsToday)[number]) => {
      const lead = c.leadId as unknown as {
        _id?: { toString(): string };
        companyName?: string;
        contactPerson?: string;
        leadCode?: string;
      } | null;
      return {
        _id: c._id,
        leadId: lead?._id ?? c.leadId,
        phoneNumber: c.phoneNumber,
        callStartTime: c.callStartTime,
        callEndTime: c.callEndTime,
        durationSeconds: c.durationSeconds,
        callOutcome: c.callOutcome,
        clientCallId: c.clientCallId,
        lead,
      };
    };

    const mapFollowUp = (f: {
      _id: { toString(): string };
      leadId: unknown;
      clientCallId?: string;
      callRecordingId?: { toString(): string } | null;
      callOutcome?: string;
      createdAt: Date;
    }) => ({
      _id: f._id,
      leadId: f.leadId,
      clientCallId: f.clientCallId,
      callRecordingId: f.callRecordingId,
      callOutcome: f.callOutcome,
      createdAt: f.createdAt,
    });

    const dialsToday = mergeDials(
      recordingsToday.map(mapRecording),
      remotesToday.map((c) => ({
        _id: c._id,
        callId: c.callId,
        leadId: c.leadId,
        phoneNumber: c.phoneNumber,
        startTime: c.startTime,
        endTime: c.endTime,
        durationSeconds: c.durationSeconds,
        status: c.status,
      })),
      followUpsTodayDocs.map(mapFollowUp)
    );
    const dialsWeek = mergeDials(
      recordingsWeek.map((c) => ({
        _id: c._id,
        leadId: c.leadId,
        phoneNumber: c.phoneNumber,
        callStartTime: c.callStartTime,
        callEndTime: c.callEndTime,
        durationSeconds: c.durationSeconds,
        callOutcome: c.callOutcome,
        clientCallId: c.clientCallId,
        lead: null,
      })),
      remotesWeek.map((c) => ({
        _id: c._id,
        callId: c.callId,
        leadId: c.leadId,
        phoneNumber: c.phoneNumber,
        startTime: c.startTime,
        endTime: c.endTime,
        durationSeconds: c.durationSeconds,
        status: c.status,
      })),
      followUpsWeekDocs.map(mapFollowUp)
    );
    const dialsAll = mergeDials(
      recordingsAll.map((c) => ({
        _id: c._id,
        leadId: c.leadId,
        phoneNumber: '',
        callStartTime: c.callStartTime,
        durationSeconds: 0,
        clientCallId: c.clientCallId,
        lead: null,
      })),
      remotesAll.map((c) => ({
        _id: c._id,
        callId: c.callId,
        leadId: c.leadId,
        phoneNumber: '',
        startTime: c.startTime,
        durationSeconds: 0,
        status: 'ended',
      })),
      followUpsAllDocs.map(mapFollowUp)
    );

    let talkSecondsToday = 0;
    for (const c of dialsToday) talkSecondsToday += c.durationSeconds;

    const dayBuckets: Record<string, { count: number; talk_seconds: number }> = {};
    for (let i = 6; i >= 0; i--) {
      dayBuckets[dateKeyIst(daysAgoIst(i))] = { count: 0, talk_seconds: 0 };
    }
    let talkSecondsWeek = 0;
    for (const c of dialsWeek) {
      talkSecondsWeek += c.durationSeconds;
      const key = dateKeyIst(c.startTime);
      if (key in dayBuckets) {
        dayBuckets[key].count += 1;
        dayBuckets[key].talk_seconds += c.durationSeconds;
      }
    }

    const fillToday = avgFormFill(followUpsTodayDocs);
    const fillWeek = avgFormFill(followUpsWeekDocs);
    const followUpsToday = followUpsTodayDocs.length;
    const followUpsWeek = followUpsWeekDocs.length;

    const recentCalls = dialsToday.slice(0, 25).map((c) => ({
      id: c.id,
      lead_id: c.leadId,
      company_name: c.companyName,
      contact_person: c.contactPerson,
      lead_code: c.leadCode,
      phone_number: c.phoneNumber,
      call_start_time: c.startTime.toISOString(),
      call_end_time: c.endTime?.toISOString() ?? null,
      duration_seconds: c.durationSeconds,
      call_outcome: c.callOutcome,
      source: c.source,
    }));

    console.log('[me/dashboard] ok', {
      userId,
      pendingLeads,
      calledLeads,
      dialsToday: dialsToday.length,
      dialsWeek: dialsWeek.length,
      dialsAll: dialsAll.length,
      ms: Date.now() - startedAt,
    });

    res.json({
      data: {
        telecaller: {
          id: user._id.toString(),
          name: user.name,
          email: user.email,
          team_name: user.teamName ?? null,
        },
        summary: {
          assigned_leads: populated.length,
          pending_leads: pendingLeads,
          called_leads: calledLeads,
          calls_today: dialsToday.length,
          calls_last_7_days: dialsWeek.length,
          calls_all_time: dialsAll.length,
          talk_seconds_today: talkSecondsToday,
          talk_seconds_last_7_days: talkSecondsWeek,
          follow_ups_today: followUpsToday,
          follow_ups_last_7_days: followUpsWeek,
          avg_form_fill_seconds_today: fillToday.avg,
          avg_form_fill_seconds_last_7_days: fillWeek.avg,
          form_fills_today: fillToday.count,
          form_fills_last_7_days: fillWeek.count,
        },
        calls_by_day: Object.entries(dayBuckets).map(([date, v]) => ({
          date,
          count: v.count,
          talk_seconds: v.talk_seconds,
        })),
        recent_calls: recentCalls,
      },
    });
  } catch (err) {
    console.error('[me/dashboard] failed', {
      userId: req.user?.id,
      email: req.user?.email,
      err: err instanceof Error ? err.message : err,
      ms: Date.now() - startedAt,
    });
    next(err);
  }
});

/** Own Daily Sales Telecalling Report for a selected day. */
meDashboardRouter.get('/dashboard/sales-report', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new AppError(401, 'Authentication required.');
    const { rangeStart, rangeEndExclusive } = parseReportRange(req.query);
    const report = await buildDailySalesReport(userId, rangeStart, rangeEndExclusive);
    res.json({ data: report });
  } catch (err) {
    if (err instanceof Error && err.message === 'Telecaller not found') {
      return next(new AppError(404, err.message));
    }
    next(err);
  }
});

meDashboardRouter.get('/dashboard/sales-report/text', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new AppError(401, 'Authentication required.');
    const { rangeStart, rangeEndExclusive } = parseReportRange(req.query);
    const report = await buildDailySalesReport(userId, rangeStart, rangeEndExclusive);
    res.type('text/plain; charset=utf-8').send(formatDailySalesReportText(report));
  } catch (err) {
    if (err instanceof Error && err.message === 'Telecaller not found') {
      return next(new AppError(404, err.message));
    }
    next(err);
  }
});

meDashboardRouter.get('/dashboard/sales-report/export', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new AppError(401, 'Authentication required.');
    const { rangeStart, rangeEndExclusive, fromKey, toKey } = parseReportRange(req.query);
    const report = await buildDailySalesReport(userId, rangeStart, rangeEndExclusive);
    const buffer = await buildDailySalesReportWorkbook([report]);
    const stamp =
      fromKey === toKey
        ? fromKey.replace(/-/g, '')
        : `${fromKey.replace(/-/g, '')}_${toKey.replace(/-/g, '')}`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Daily_Sales_Report_${stamp}.xlsx"`
    );
    res.send(buffer);
  } catch (err) {
    if (err instanceof Error && err.message === 'Telecaller not found') {
      return next(new AppError(404, err.message));
    }
    next(err);
  }
});
