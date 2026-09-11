import { CallRecording, Lead, LeadAssignment, LeadFollowUp, RemoteCall, User } from '../models';
import { ILead } from '../models/Lead';
import { countAgentTabTotals } from '../modules/leads/leadListFilters';
import { dateKeyIst, daysAgoIst, startOfIstDay } from '../utils/istCalendar';
import { localRecordingExists } from './localRecordingStore';

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

function normalizeOutcome(raw: string | undefined | null): string {
  const v = (raw || 'unknown').trim();
  if (v === 'not_pickup' || v === 'no_answer' || v === 'noAnswer') return 'notPickup';
  if (v === 'not_connected') return 'notConnected';
  if (v === 'wrong_number') return 'wrongNumber';
  if (v === 'decision_maker' || v === 'decision_maker_connected') return 'decisionMakerConnected';
  if (v === 'connected' || v === 'ended' || v === 'active') return 'received';
  if (v === 'rejected' || v === 'failed') return 'notConnected';
  return v || 'unknown';
}

function normalizeLeadResultToken(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  const map: Record<string, string> = {
    interested: 'interested',
    not_interested: 'not_interested',
    'not interested': 'not_interested',
    follow_up_required: 'follow_up_required',
    'follow-up required': 'follow_up_required',
    followup_required: 'follow_up_required',
    qualified: 'qualified',
    'qualified lead': 'qualified',
    rate_provided: 'rate_provided',
    'rate provided': 'rate_provided',
    closed: 'closed',
    'closed / order received': 'closed',
    order_received: 'closed',
  };
  return map[v] ?? null;
}

function tallyTodayFromDials(dials: DialEvent[]) {
  let connected = 0;
  let noAnswer = 0;
  let busy = 0;
  let wrongNumber = 0;
  let raw = 0;
  let followUp = 0;
  let talkSeconds = 0;
  for (const d of dials) {
    talkSeconds += Math.max(0, d.durationSeconds || 0);
    if (d.source === 'follow_up') followUp += 1;
    else raw += 1;
    switch (normalizeOutcome(d.callOutcome)) {
      case 'received':
      case 'decisionMakerConnected':
        connected += 1;
        break;
      case 'notPickup':
        noAnswer += 1;
        break;
      case 'busy':
      case 'notConnected':
        busy += 1;
        break;
      case 'wrongNumber':
        wrongNumber += 1;
        break;
      default:
        break;
    }
  }
  return { connected, noAnswer, busy, wrongNumber, raw, followUp, talkSeconds, attempted: dials.length };
}

function tallyLeadSalesToday(
  followUps: Array<{ leadResult?: string | null; nextFollowupDate?: Date | null }>
) {
  let interested = 0;
  let notInterested = 0;
  let followUpRequired = 0;
  let qualified = 0;
  let rateProvided = 0;
  let closed = 0;
  let nextFollowUps = 0;
  for (const f of followUps) {
    if (f.nextFollowupDate) nextFollowUps += 1;
    const raw = f.leadResult || '';
    const parts = raw.split(/[,|;]/);
    const seen = new Set<string>();
    for (const part of parts) {
      const n = normalizeLeadResultToken(part);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      switch (n) {
        case 'interested':
          interested += 1;
          break;
        case 'not_interested':
          notInterested += 1;
          break;
        case 'follow_up_required':
          followUpRequired += 1;
          break;
        case 'qualified':
          qualified += 1;
          break;
        case 'rate_provided':
          rateProvided += 1;
          break;
        case 'closed':
          closed += 1;
          break;
        default:
          break;
      }
    }
  }
  return {
    interested,
    notInterested,
    followUpRequired,
    qualified,
    rateProvided,
    closed,
    nextFollowUps,
  };
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
    if (!list || list.length === 0) return false;
    return list.some((t) => Math.abs(t - startMs) <= windowMs);
  };

  for (const f of followUps) {
    const leadKey = refId(f.leadId);
    const startMs = f.createdAt ? new Date(f.createdAt).getTime() : Date.now();
    const clientId = f.clientCallId?.trim() || '';
    const talk = (clientId ? talkByClientCallId.get(clientId) : undefined) ?? 0;
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

/** Fill company / contact / phone from Lead docs (mergeDials leaves placeholders). */
async function attachLeadDetails(events: DialEvent[]): Promise<DialEvent[]> {
  const ids = [...new Set(events.map((e) => e.leadId).filter(Boolean))];
  if (ids.length === 0) return events;

  const leads = await Lead.find({ _id: { $in: ids } })
    .select('companyName company name contactPerson contactMobile phoneNumber leadCode')
    .lean();
  const byId = new Map(leads.map((l) => [String(l._id), l]));

  return events.map((e) => {
    const lead = byId.get(e.leadId);
    if (!lead) return e;
    const company =
      (lead.companyName || lead.company || lead.name || '').trim() || e.companyName || '—';
    return {
      ...e,
      companyName: company,
      contactPerson: lead.contactPerson ?? e.contactPerson,
      leadCode: lead.leadCode ?? e.leadCode,
      phoneNumber:
        e.phoneNumber?.trim() ||
        lead.contactMobile ||
        lead.phoneNumber ||
        '',
    };
  });
}

/**
 * Fast personal performance dashboard.
 * Avoids full-history scans and the heavy daily-sales rebuild (those were causing
 * live 15s timeouts / 502s). Today KPIs are derived from the same week window.
 */
export async function buildTelecallerPerformanceDashboard(userId: string) {
  const startedAt = Date.now();
  const user = await User.findById(userId).select('name email role teamName isActive');
  if (!user) {
    throw new Error('Telecaller not found');
  }
  if (user.isActive === false) {
    throw new Error('Telecaller not found');
  }

  const todayStart = startOfIstDay();
  const weekStart = daysAgoIst(6);

  const [assignmentDocs, talkRecordingsWeek, remotesWeek, followUpsWeekDocs, remotesAllCount, followUpsAllCount] =
    await Promise.all([
      // Only fields needed for Remaining / Called counts — never hydrate full lead docs.
      LeadAssignment.find({ agentId: userId, isActive: true })
        .select('leadId assignedAt')
        .populate<{ leadId: ILead }>('leadId', 'callCount lastCalledAt nextFollowupDate'),
      CallRecording.find({ agentId: userId, callStartTime: { $gte: weekStart } })
        .select('durationSeconds clientCallId callStartTime')
        .lean(),
      RemoteCall.find({
        agentId: userId,
        startTime: { $gte: weekStart },
        status: { $in: [...REMOTE_TERMINAL] },
      })
        .select('leadId phoneNumber durationSeconds startTime endTime status callId')
        .lean(),
      LeadFollowUp.find({ agentId: userId, createdAt: { $gte: weekStart } })
        .select(
          'leadId clientCallId callRecordingId callOutcome createdAt formFillSeconds leadResult nextFollowupDate'
        )
        .lean(),
      RemoteCall.countDocuments({
        agentId: userId,
        status: { $in: [...REMOTE_TERMINAL] },
      }),
      LeadFollowUp.countDocuments({ agentId: userId }),
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

  const remotesToday = remotesWeek.filter((c) => c.startTime >= todayStart);
  const followUpsTodayDocs = followUpsWeekDocs.filter((f) => f.createdAt >= todayStart);

  const mapFollowUp = (f: (typeof followUpsWeekDocs)[number]) => ({
    _id: f._id,
    leadId: f.leadId,
    clientCallId: f.clientCallId,
    callRecordingId: f.callRecordingId,
    callOutcome: f.callOutcome,
    createdAt: f.createdAt,
  });

  const mapRemote = (c: (typeof remotesWeek)[number]) => ({
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
  const callsAllTime = Math.max(remotesAllCount, followUpsAllCount, dialsWeek.length);

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
  const todayCalling = tallyTodayFromDials(dialsToday);
  const todaySales = tallyLeadSalesToday(followUpsTodayDocs);

  const recentCalls = (await attachLeadDetails(dialsToday.slice(0, 25))).map((c) => ({
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

  console.log('[dashboard] built', {
    userId,
    assigned: populated.length,
    dialsToday: dialsToday.length,
    ms: Date.now() - startedAt,
  });

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
      calls_today: todayCalling.attempted,
      calls_from_raw_leads_today: todayCalling.raw,
      calls_from_follow_ups_today: todayCalling.followUp,
      calls_connected_today: todayCalling.connected,
      no_answer_today: todayCalling.noAnswer,
      busy_today: todayCalling.busy,
      wrong_number_today: todayCalling.wrongNumber,
      calls_last_7_days: dialsWeek.length,
      calls_all_time: callsAllTime,
      talk_seconds_today: todayCalling.talkSeconds,
      talk_seconds_last_7_days: talkSecondsWeek,
      follow_ups_today: followUpsTodayDocs.length,
      follow_ups_last_7_days: followUpsWeekDocs.length,
      next_follow_ups_today: todaySales.nextFollowUps,
      interested_today: todaySales.interested,
      not_interested_today: todaySales.notInterested,
      follow_up_required_today: todaySales.followUpRequired,
      qualified_today: todaySales.qualified,
      rate_provided_today: todaySales.rateProvided,
      closed_today: todaySales.closed,
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

export type CompanyDialRow = {
  agentId: string;
  startTime: Date;
  durationSeconds: number;
  callOutcome: string | null;
  source: 'follow_up' | 'remote';
};

function outcomeFromRemoteStatus(status: string): string {
  switch (status) {
    case 'ended':
    case 'active':
      return 'received';
    case 'no_answer':
      return 'notPickup';
    case 'busy':
      return 'busy';
    case 'failed':
    case 'rejected':
      return 'notConnected';
    default:
      return 'unknown';
  }
}

/**
 * Company-wide dials for admin dashboard (same rules as telecaller Performance):
 * follow-up forms + remote dials; recordings never count as dials.
 * Only active telecallers are included (test / deactivated users excluded).
 */
export async function loadCompanyDials(
  rangeStart: Date,
  rangeEndExclusive: Date
): Promise<CompanyDialRow[]> {
  const activeAgents = await User.find({
    role: { $in: ['agent', 'manager'] },
    isActive: true,
  }).select('_id');
  const activeIds = activeAgents.map((u) => u._id);
  if (activeIds.length === 0) return [];

  const [followUps, remotes, talkRecordings] = await Promise.all([
    LeadFollowUp.find({
      agentId: { $in: activeIds },
      createdAt: { $gte: rangeStart, $lt: rangeEndExclusive },
    }).select('agentId leadId clientCallId callOutcome createdAt'),
    RemoteCall.find({
      agentId: { $in: activeIds },
      startTime: { $gte: rangeStart, $lt: rangeEndExclusive },
      status: { $in: [...REMOTE_TERMINAL] },
    }).select('agentId callId leadId startTime durationSeconds status'),
    CallRecording.find({
      agentId: { $in: activeIds },
      callStartTime: { $gte: rangeStart, $lt: rangeEndExclusive },
    }).select('clientCallId durationSeconds'),
  ]);

  const talkByClient = new Map<string, number>();
  for (const r of talkRecordings) {
    if (!r.clientCallId) continue;
    const secs = Math.max(0, r.durationSeconds || 0);
    talkByClient.set(r.clientCallId, Math.max(talkByClient.get(r.clientCallId) ?? 0, secs));
  }

  const rows: CompanyDialRow[] = [];
  const countedClientIds = new Set<string>();
  const dialTimesByLeadAgent = new Map<string, number[]>();
  const keyFor = (agentId: string, leadId: string) => `${agentId}:${leadId}`;

  const near = (agentId: string, leadId: string, startMs: number, windowMs = 5 * 60 * 1000) => {
    const list = dialTimesByLeadAgent.get(keyFor(agentId, leadId));
    if (!list?.length) return false;
    return list.some((t) => Math.abs(t - startMs) <= windowMs);
  };

  const mark = (agentId: string, leadId: string, startMs: number, clientId?: string | null) => {
    if (clientId) countedClientIds.add(clientId);
    if (!leadId) return;
    const k = keyFor(agentId, leadId);
    const list = dialTimesByLeadAgent.get(k) ?? [];
    list.push(startMs);
    dialTimesByLeadAgent.set(k, list);
  };

  for (const f of followUps) {
    const agentId = f.agentId?.toString() || '';
    if (!agentId) continue;
    const clientId = f.clientCallId?.trim() || '';
    const leadId = f.leadId?.toString() || '';
    const startMs = f.createdAt ? new Date(f.createdAt).getTime() : Date.now();
    rows.push({
      agentId,
      startTime: f.createdAt,
      durationSeconds: clientId ? talkByClient.get(clientId) ?? 0 : 0,
      callOutcome: f.callOutcome ?? null,
      source: 'follow_up',
    });
    mark(agentId, leadId, startMs, clientId || null);
  }

  for (const c of remotes) {
    const agentId = c.agentId?.toString() || '';
    if (!agentId) continue;
    if (c.callId && countedClientIds.has(c.callId)) continue;
    const leadId = c.leadId?.toString() || '';
    const startMs = new Date(c.startTime).getTime();
    if (leadId && near(agentId, leadId, startMs)) continue;

    rows.push({
      agentId,
      startTime: c.startTime,
      durationSeconds: Math.max(0, c.durationSeconds || 0),
      callOutcome: outcomeFromRemoteStatus(c.status),
      source: 'remote',
    });
    mark(agentId, leadId, startMs, c.callId);
  }

  return rows;
}

/**
 * Agent Call History for the app (Windows has no local SQLite — must use server dials).
 * Returns newest-first rows shaped like lead call recordings for the Flutter client.
 */
export async function listAgentCallHistory(userId: string, limit = 150) {
  const since = daysAgoIst(60);
  const [remotes, followUps, talkRecordings] = await Promise.all([
    RemoteCall.find({
      agentId: userId,
      status: { $in: [...REMOTE_TERMINAL] },
      startTime: { $gte: since },
    })
      .sort({ startTime: -1 })
      .limit(limit * 2)
      .lean(),
    LeadFollowUp.find({
      agentId: userId,
      createdAt: { $gte: since },
    })
      .sort({ createdAt: -1 })
      .limit(limit * 2)
      .lean(),
    CallRecording.find({
      agentId: userId,
      callStartTime: { $gte: since },
    })
      .select('clientCallId durationSeconds uploadStatus _id s3Key s3Bucket')
      .lean(),
  ]);

  const talkByClient = new Map<string, number>();
  const recordingByClient = new Map<string, { id: string; uploaded: boolean }>();
  for (const r of talkRecordings) {
    if (!r.clientCallId) continue;
    const secs = Math.max(0, r.durationSeconds || 0);
    talkByClient.set(r.clientCallId, Math.max(talkByClient.get(r.clientCallId) ?? 0, secs));
    const fileOnDisk = !r.s3Key || r.s3Bucket === 'local' ? localRecordingExists(r.s3Key || '') : true;
    recordingByClient.set(r.clientCallId, {
      id: r._id.toString(),
      uploaded: r.uploadStatus === 'uploaded' && fileOnDisk,
    });
  }

  const dials = await attachLeadDetails(
    mergeDials(
      remotes.map((c) => ({
        _id: c._id,
        callId: c.callId,
        leadId: c.leadId,
        phoneNumber: c.phoneNumber,
        startTime: c.startTime,
        endTime: c.endTime,
        durationSeconds: c.durationSeconds,
        status: c.status,
      })),
      followUps.map((f) => ({
        _id: f._id,
        leadId: f.leadId,
        clientCallId: f.clientCallId,
        callRecordingId: f.callRecordingId,
        callOutcome: f.callOutcome,
        createdAt: f.createdAt,
      })),
      talkByClient
    )
  );

  return dials.slice(0, Math.max(1, Math.min(500, limit))).map((c) => {
    const rec = c.clientCallId ? recordingByClient.get(c.clientCallId) : undefined;
    return {
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
      client_call_id: c.clientCallId ?? null,
      source: c.source,
      recording_id: rec?.uploaded ? rec.id : null,
      recording_url: rec?.uploaded ? `recordings/${rec.id}/file` : null,
      has_recording: Boolean(rec?.uploaded),
    };
  });
}
