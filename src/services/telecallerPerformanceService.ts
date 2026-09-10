import { CallRecording, LeadAssignment, LeadFollowUp, RemoteCall, User } from '../models';
import { ILead } from '../models/Lead';
import { buildDailySalesReport } from './dailySalesReportService';
import { countAgentTabTotals } from '../modules/leads/leadListFilters';
import { dateKeyIst, daysAgoIst, startOfIstDay } from '../utils/istCalendar';

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
 * Merge remotes + follow-up dials.
 * CallRecording is never counted as a dial (only exists when customer picked up).
 */
function mergeDials(
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
  }> = [],
  talkByClientCallId: Map<string, number> = new Map()
): DialEvent[] {
  const events: DialEvent[] = [];
  const countedClientIds = new Set<string>();
  const dialTimesByLead = new Map<string, number[]>();

  const mark = (leadKey: string, startMs: number, clientId?: string | null) => {
    if (clientId) countedClientIds.add(clientId);
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

  for (const f of followUps) {
    const clientId = f.clientCallId?.trim() || '';
    const leadKey = refId(f.leadId);
    const startMs = f.createdAt ? new Date(f.createdAt).getTime() : Date.now();
    const talk = clientId ? talkByClientCallId.get(clientId) ?? 0 : 0;

    events.push({
      id: f._id.toString(),
      leadId: leadKey,
      phoneNumber: f.phoneNumber || '',
      startTime: f.createdAt,
      endTime: null,
      durationSeconds: talk,
      callOutcome: f.callOutcome ?? null,
      companyName: '—',
      contactPerson: null,
      leadCode: null,
      source: 'follow_up',
      clientCallId: clientId || null,
    });
    mark(leadKey, startMs, clientId || null);
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

  events.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
  return events;
}

/** Same performance payload for telecaller "My Performance" and admin drill-down. */
export async function buildTelecallerPerformanceDashboard(userId: string) {
  const user = await User.findById(userId).select('name email role teamName isActive');
  if (!user) {
    throw new Error('Telecaller not found');
  }
  if (user.isActive === false) {
    throw new Error('Telecaller not found');
  }

  const todayStart = startOfIstDay();
  const weekStart = daysAgoIst(6);
  const allTimeStart = new Date(0);

  const [
    assignmentDocs,
    talkRecordingsWeek,
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
    CallRecording.find({ agentId: userId, callStartTime: { $gte: weekStart } }).select(
      'durationSeconds clientCallId callStartTime'
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

  const talkByClientToday = new Map<string, number>();
  const talkByClientWeek = new Map<string, number>();
  for (const r of talkRecordingsWeek) {
    const secs = Math.max(0, r.durationSeconds || 0);
    if (!r.clientCallId) continue;
    talkByClientWeek.set(r.clientCallId, Math.max(talkByClientWeek.get(r.clientCallId) ?? 0, secs));
    if (r.callStartTime >= todayStart) {
      talkByClientToday.set(
        r.clientCallId,
        Math.max(talkByClientToday.get(r.clientCallId) ?? 0, secs)
      );
    }
  }

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

  const mapRemote = (c: (typeof remotesToday)[number]) => ({
    _id: c._id,
    callId: c.callId,
    leadId: c.leadId,
    phoneNumber: c.phoneNumber,
    startTime: c.startTime,
    endTime: c.endTime,
    durationSeconds: c.durationSeconds,
    status: c.status,
  });

  const dialsToday = mergeDials(
    remotesToday.map(mapRemote),
    followUpsTodayDocs.map(mapFollowUp),
    talkByClientToday
  );
  const dialsWeek = mergeDials(
    remotesWeek.map(mapRemote),
    followUpsWeekDocs.map(mapFollowUp),
    talkByClientWeek
  );
  const dialsAll = mergeDials(
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

  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const todayReport = await buildDailySalesReport(userId, todayStart, tomorrowStart);

  return {
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
      calls_today: todayReport.calling.calls_attempted,
      calls_from_raw_leads_today: todayReport.calling.calls_from_raw_leads,
      calls_from_follow_ups_today: todayReport.calling.calls_from_follow_ups,
      calls_connected_today: todayReport.calling.calls_connected,
      no_answer_today: todayReport.calling.no_answer,
      busy_today: todayReport.calling.busy_switched_off,
      wrong_number_today: todayReport.calling.wrong_number,
      calls_last_7_days: dialsWeek.length,
      calls_all_time: dialsAll.length,
      talk_seconds_today: Math.max(talkSecondsToday, todayReport.talk_seconds),
      talk_seconds_last_7_days: talkSecondsWeek,
      follow_ups_today: followUpsToday,
      follow_ups_last_7_days: followUpsWeek,
      next_follow_ups_today: todayReport.next_follow_up.total_follow_up_calls,
      interested_today: todayReport.lead_sales.interested,
      not_interested_today: todayReport.lead_sales.not_interested,
      follow_up_required_today: todayReport.lead_sales.follow_up_required,
      qualified_today: todayReport.lead_sales.qualified_leads,
      rate_provided_today: todayReport.lead_sales.rate_provided,
      closed_today: todayReport.lead_sales.closed_order_received,
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
  };
}
