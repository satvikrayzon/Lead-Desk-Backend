import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { CallRecording, Lead, LeadAssignment, LeadFollowUp, User } from '../../models';
import { AuthRequest } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import { createAuditLog, formatLead } from '../../utils/helpers';
import { assignmentInsertFromLead, listFieldsFromAssignment } from '../../services/assignmentListSync';
import { toApiRole } from '../../utils/roleMapping';
import { dateKeyIst, daysAgoIst, startOfIstDay } from '../../utils/istCalendar';
import { effectiveRecordingTalkSeconds } from '../../utils/audioDuration';
import {
  buildAllDailySalesReports,
  buildDailySalesReport,
  buildDailySalesReportWorkbook,
  formatDailySalesReportText,
  parseReportRange,
} from '../../services/dailySalesReportService';
import {
  buildTelecallerPerformanceDashboard,
  loadCompanyDials,
} from '../../services/telecallerPerformanceService';
import {
  withAdminDashCache,
} from '../../services/dashboardCache';
import {
  hydratePendingLeads,
  loadAssignmentStatsByAgent,
  loadPendingAssignmentKeys,
} from '../../services/assignmentLeadLite';
import { buildAdminDashboardWorkbook } from '../../services/adminDashboardExport';

export const adminDashboardRouter = Router();

function startOfDay(d = new Date()) {
  return startOfIstDay(d);
}

function daysAgo(n: number) {
  return daysAgoIst(n);
}

/** Calendar day in IST. */
function dateKey(d: Date) {
  return dateKeyIst(d);
}

/** Parse YYYY-MM-DD as IST calendar day start; falls back to null. */
function parseDayStart(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parts = raw.trim().split('-').map((p) => Number(p));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  const [y, m, day] = parts;
  const mm = String(m).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return new Date(`${y}-${mm}-${dd}T00:00:00+05:30`);
}

function endOfDayExclusive(dayStart: Date) {
  return new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
}

function normalizeOutcome(raw: string | undefined | null): string {
  const v = (raw || 'unknown').trim();
  if (v === 'not_pickup') return 'notPickup';
  if (v === 'not_connected') return 'notConnected';
  if (v === 'wrong_number') return 'wrongNumber';
  if (v === 'busy') return 'busy';
  if (v === 'received' || v === 'connected') return 'received';
  if (v === 'no_answer' || v === 'noAnswer') return 'notPickup';
  return v || 'unknown';
}

function refId(ref: unknown): string {
  if (ref == null) return '';
  if (typeof ref === 'object' && ref !== null && '_id' in (ref as object)) {
    return String((ref as { _id: unknown })._id);
  }
  return String(ref);
}

/** Company-wide dashboard: summary + insights + per-telecaller report. */
adminDashboardRouter.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { days, rangeStart, rangeEndExclusive } = parseAdminDashboardRange(req.query);
    const data = await loadAdminDashboardPayload(days, rangeStart, rangeEndExclusive);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

/** Excel export — all telecallers in one workbook (one row per user). */
adminDashboardRouter.get('/export', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { days, rangeStart, rangeEndExclusive } = parseAdminDashboardRange(req.query);
    const [data, salesReports] = await Promise.all([
      loadAdminDashboardPayload(days, rangeStart, rangeEndExclusive),
      buildAllDailySalesReports(rangeStart, rangeEndExclusive),
    ]);
    const buffer = await buildAdminDashboardWorkbook(
      data as Parameters<typeof buildAdminDashboardWorkbook>[0],
      salesReports
    );
    const from = (data as { range?: { from?: string } }).range?.from?.replace(/-/g, '') ?? 'from';
    const to = (data as { range?: { to?: string } }).range?.to?.replace(/-/g, '') ?? 'to';
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="All_Telecallers_Report_${from}_${to}.xlsx"`
    );
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

/**
 * Activity series for Calls / Talk time chart.
 * Optional `agent_id` scopes to one telecaller; omit for company-wide.
 */
adminDashboardRouter.get('/activity', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { days, rangeStart, rangeEndExclusive } = parseAdminDashboardRange(req.query);
    const agentIdRaw = typeof req.query.agent_id === 'string' ? req.query.agent_id.trim() : '';
    if (agentIdRaw && !Types.ObjectId.isValid(agentIdRaw)) {
      throw new AppError(400, 'Invalid agent id.');
    }

    let activeAgentIds: Types.ObjectId[];
    if (agentIdRaw) {
      activeAgentIds = [new Types.ObjectId(agentIdRaw)];
    } else {
      const agents = await User.find({
        role: { $in: ['agent', 'manager'] },
        isActive: true,
      })
        .select('_id')
        .lean();
      activeAgentIds = agents.map((a) => a._id as Types.ObjectId);
    }

    const dayBuckets: Record<string, { count: number; talk_seconds: number }> = {};
    {
      const cursor = new Date(rangeStart);
      let guard = 0;
      while (cursor < rangeEndExclusive && guard < 62) {
        dayBuckets[dateKey(cursor)] = { count: 0, talk_seconds: 0 };
        cursor.setTime(cursor.getTime() + 24 * 60 * 60 * 1000);
        guard += 1;
      }
    }

    if (activeAgentIds.length === 0) {
      return res.json({
        data: {
          days,
          agent_id: agentIdRaw || null,
          calls_by_day: Object.entries(dayBuckets).map(([date, v]) => ({
            date,
            count: v.count,
            talk_seconds: v.talk_seconds,
          })),
        },
      });
    }

    const [companyDials, rangeRecordings] = await Promise.all([
      loadCompanyDials(rangeStart, rangeEndExclusive, activeAgentIds),
      CallRecording.find({
        agentId: { $in: activeAgentIds },
        callStartTime: { $gte: rangeStart, $lt: rangeEndExclusive },
      })
        .select('callStartTime durationSeconds s3Key s3Bucket')
        .lean(),
    ]);

    for (const c of companyDials.dials) {
      const key = dateKey(new Date(c.startTime));
      if (key in dayBuckets) dayBuckets[key].count += 1;
    }
    for (const r of rangeRecordings) {
      const key = dateKey(new Date(r.callStartTime));
      if (key in dayBuckets) {
        dayBuckets[key].talk_seconds += effectiveRecordingTalkSeconds(r);
      }
    }

    res.json({
      data: {
        days,
        agent_id: agentIdRaw || null,
        calls_by_day: Object.entries(dayBuckets).map(([date, v]) => ({
          date,
          count: v.count,
          talk_seconds: v.talk_seconds,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

function parseAdminDashboardRange(query: AuthRequest['query']): {
  days: number;
  rangeStart: Date;
  rangeEndExclusive: Date;
} {
  const todayStart = startOfDay();
  const daysRaw = Number(query.days ?? 7);
  const days = [1, 7, 14, 30].includes(daysRaw) ? daysRaw : 7;
  const fromQuery = parseDayStart(query.from);
  const toQuery = parseDayStart(query.to);
  const rangeStart = fromQuery ?? daysAgo(days - 1);
  const rangeEndExclusive = toQuery ? endOfDayExclusive(toQuery) : endOfDayExclusive(todayStart);
  if (rangeEndExclusive <= rangeStart) {
    throw new AppError(400, 'Invalid date range.');
  }
  return { days, rangeStart, rangeEndExclusive };
}

async function loadAdminDashboardPayload(days: number, rangeStart: Date, rangeEndExclusive: Date) {
  const todayStart = startOfDay();
  const tomorrowStart = endOfDayExclusive(todayStart);
  const cacheKey = `${days}|${rangeStart.toISOString()}|${rangeEndExclusive.toISOString()}`;
  return withAdminDashCache(cacheKey, async () => {
    const agents = await User.find({
      role: { $in: ['agent', 'manager'] },
      isActive: true,
    })
      .select('name email role teamId teamName')
      .sort({ name: 1 })
      .lean();
    const activeAgentIds = agents.map((a) => a._id);
    if (activeAgentIds.length === 0) {
      const empty = {
        range: {
          from: dateKey(rangeStart),
          to: dateKey(new Date(rangeEndExclusive.getTime() - 1)),
          days,
        },
        summary: {
          total_leads: 0,
          total_telecallers: 0,
          calls_today: 0,
          pending_leads: 0,
          calls_last_7_days: 0,
          talk_seconds_today: 0,
          talk_seconds_last_7_days: 0,
          avg_form_fill_seconds_today: 0,
          avg_form_fill_seconds_last_7_days: 0,
          form_fills_today: 0,
          form_fills_last_7_days: 0,
          overdue_followups: 0,
          due_today_followups: 0,
          connected_calls_in_range: 0,
          recordings_uploaded_in_range: 0,
          recording_coverage_percent: 0,
          idle_telecallers_today: 0,
        },
        alerts: [],
        call_outcomes: [],
        leaderboard: [],
        overdue_followups: [],
        calls_by_day: [],
        telecallers: [],
        pending_leads: [],
      };
      return empty;
    }

    const [assignmentStats, companyDials, overdueFollowUps, dueTodayFollowUps, followUpsRange, pendingKeys] =
      await Promise.all([
      loadAssignmentStatsByAgent(activeAgentIds as Types.ObjectId[], tomorrowStart),
      loadCompanyDials(rangeStart, rangeEndExclusive, activeAgentIds),
      LeadFollowUp.find({
        agentId: { $in: activeAgentIds },
        nextFollowupDate: { $ne: null, $lt: todayStart },
      })
        .select('leadId agentId nextFollowupDate remarks sequenceNumber')
        .sort({ nextFollowupDate: 1 })
        .limit(40)
        .populate('leadId', 'companyName contactPerson contactMobile leadCode leadStage')
        .populate('agentId', 'name email teamName')
        .lean(),
      LeadFollowUp.find({
        agentId: { $in: activeAgentIds },
        nextFollowupDate: { $gte: todayStart, $lt: tomorrowStart },
      })
        .select('leadId')
        .lean(),
      LeadFollowUp.find({
        agentId: { $in: activeAgentIds },
        createdAt: { $gte: rangeStart, $lt: rangeEndExclusive },
      })
        .select('agentId formFillSeconds createdAt')
        .lean(),
      loadPendingAssignmentKeys({ isActive: true, agentId: { $in: activeAgentIds } }, tomorrowStart, 40),
    ]);

    const dialsRange = companyDials.dials;
    const talkByAgentRange = companyDials.talkByAgent;
    const pendingLeadsPreview = await hydratePendingLeads(pendingKeys);

    const overdueLeadIds = new Set(overdueFollowUps.map((f) => refId(f.leadId)).filter(Boolean));

    const assignedByAgent = new Map<string, number>();
    const pendingByAgent = new Map<string, number>();
    let totalLeads = 0;
    let pendingLeadsTotal = 0;
    for (const [aid, row] of assignmentStats) {
      assignedByAgent.set(aid, row.assigned);
      pendingByAgent.set(aid, row.remaining);
      totalLeads += row.assigned;
      pendingLeadsTotal += row.remaining;
    }

    const dialsToday = dialsRange.filter((c) => c.startTime >= todayStart && c.startTime < tomorrowStart);
    const formFillsToday = followUpsRange.filter(
      (f) => f.createdAt >= todayStart && f.createdAt < tomorrowStart && typeof f.formFillSeconds === 'number' && f.formFillSeconds >= 0
    );
    const formFillsRange = followUpsRange.filter(
      (f) => typeof f.formFillSeconds === 'number' && f.formFillSeconds >= 0
    );

    const callsTodayByAgent = new Map<string, number>();
    const talkTodayByAgent = new Map<string, number>();
    const rawLeadsTodayByAgent = new Map<string, number>();
    const rawLeadsRangeByAgent = new Map<string, number>();
    let talkSecondsToday = 0;
    for (const c of dialsToday) {
      const aid = c.agentId;
      callsTodayByAgent.set(aid, (callsTodayByAgent.get(aid) ?? 0) + 1);
      if (c.source !== 'follow_up') {
        rawLeadsTodayByAgent.set(aid, (rawLeadsTodayByAgent.get(aid) ?? 0) + 1);
      }
    }
    // Talk today from recordings (not dial join) — matches uploaded audio length.
    const todayRecordings = await CallRecording.find({
      agentId: { $in: activeAgentIds },
      callStartTime: { $gte: todayStart, $lt: tomorrowStart },
    })
      .select('agentId durationSeconds s3Key s3Bucket')
      .lean();
    for (const r of todayRecordings) {
      const aid = r.agentId?.toString() || '';
      if (!aid) continue;
      const secs = effectiveRecordingTalkSeconds(r);
      talkTodayByAgent.set(aid, (talkTodayByAgent.get(aid) ?? 0) + secs);
      talkSecondsToday += secs;
    }

    const callsRangeByAgent = new Map<string, number>();
    const talkRangeByAgent = new Map<string, number>(talkByAgentRange);
    const followUpsRangeByAgent = new Map<string, number>();
    const dayBuckets: Record<string, { count: number; talk_seconds: number }> = {};

    // Fill day buckets for every calendar day in range (cap 62 days).
    {
      const cursor = new Date(rangeStart);
      let guard = 0;
      while (cursor < rangeEndExclusive && guard < 62) {
        dayBuckets[dateKey(cursor)] = { count: 0, talk_seconds: 0 };
        cursor.setTime(cursor.getTime() + 24 * 60 * 60 * 1000);
        guard += 1;
      }
    }

    let talkSecondsRange = 0;
    for (const secs of talkRangeByAgent.values()) talkSecondsRange += secs;

    const outcomeCounts = new Map<string, number>();
    let connectedCalls = 0;
    let recordingsUploaded = 0;

    for (const c of dialsRange) {
      const aid = c.agentId;
      callsRangeByAgent.set(aid, (callsRangeByAgent.get(aid) ?? 0) + 1);
      if (c.source !== 'follow_up') {
        rawLeadsRangeByAgent.set(aid, (rawLeadsRangeByAgent.get(aid) ?? 0) + 1);
      }
      const key = dateKey(new Date(c.startTime));
      if (key in dayBuckets) {
        dayBuckets[key].count += 1;
      }

      const outcome = normalizeOutcome(c.callOutcome);
      outcomeCounts.set(outcome, (outcomeCounts.get(outcome) ?? 0) + 1);

      if (outcome === 'received' || outcome === 'decisionMakerConnected') {
        connectedCalls += 1;
        if (c.durationSeconds > 0) recordingsUploaded += 1;
      }
    }

    // Attribute talk to day buckets from recordings in range.
    const rangeRecordings = await CallRecording.find({
      agentId: { $in: activeAgentIds },
      callStartTime: { $gte: rangeStart, $lt: rangeEndExclusive },
    })
      .select('callStartTime durationSeconds s3Key s3Bucket')
      .lean();
    for (const r of rangeRecordings) {
      const key = dateKey(new Date(r.callStartTime));
      if (key in dayBuckets) {
        dayBuckets[key].talk_seconds += effectiveRecordingTalkSeconds(r);
      }
    }

    for (const f of followUpsRange) {
      const aid = f.agentId.toString();
      followUpsRangeByAgent.set(aid, (followUpsRangeByAgent.get(aid) ?? 0) + 1);
    }

    function avgFill(rows: { agentId: { toString(): string }; formFillSeconds?: number }[]) {
      const sumBy = new Map<string, { sum: number; count: number }>();
      let totalSum = 0;
      let totalCount = 0;
      for (const f of rows) {
        const secs = Math.max(0, f.formFillSeconds ?? 0);
        const aid = f.agentId.toString();
        const cur = sumBy.get(aid) ?? { sum: 0, count: 0 };
        cur.sum += secs;
        cur.count += 1;
        sumBy.set(aid, cur);
        totalSum += secs;
        totalCount += 1;
      }
      const avgBy = new Map<string, number>();
      for (const [id, v] of sumBy) {
        avgBy.set(id, v.count > 0 ? Math.round(v.sum / v.count) : 0);
      }
      return {
        companyAvg: totalCount > 0 ? Math.round(totalSum / totalCount) : 0,
        count: totalCount,
        avgBy,
      };
    }

    const fillToday = avgFill(formFillsToday);
    const fillRange = avgFill(formFillsRange);

    const telecallers = agents.map((a) => {
      const id = a._id.toString();
      return {
        id,
        name: a.name,
        email: a.email,
        role: toApiRole(a.role),
        team_id: a.teamId?.toString() ?? null,
        team_name: a.teamName ?? null,
        assigned_leads: assignedByAgent.get(id) ?? 0,
        pending_leads: pendingByAgent.get(id) ?? 0,
        calls_today: callsTodayByAgent.get(id) ?? 0,
        calls_last_7_days: callsRangeByAgent.get(id) ?? 0,
        calls_from_raw_leads_today: rawLeadsTodayByAgent.get(id) ?? 0,
        calls_from_raw_leads_in_range: rawLeadsRangeByAgent.get(id) ?? 0,
        talk_seconds_today: talkTodayByAgent.get(id) ?? 0,
        talk_seconds_last_7_days: talkRangeByAgent.get(id) ?? 0,
        avg_form_fill_seconds_today: fillToday.avgBy.get(id) ?? 0,
        avg_form_fill_seconds_last_7_days: fillRange.avgBy.get(id) ?? 0,
        follow_ups_in_range: followUpsRangeByAgent.get(id) ?? 0,
        idle_today: (assignedByAgent.get(id) ?? 0) > 0 && (callsTodayByAgent.get(id) ?? 0) === 0,
      };
    });

    const idleTelecallersToday = telecallers.filter((t) => t.idle_today).length;
    const recordingCoveragePercent =
      connectedCalls > 0 ? Math.round((recordingsUploaded / connectedCalls) * 100) : 0;

    const leaderboard = [...telecallers]
      .map((t) => ({
        id: t.id,
        name: t.name,
        team_name: t.team_name,
        calls: t.calls_last_7_days,
        talk_seconds: t.talk_seconds_last_7_days,
        follow_ups: t.follow_ups_in_range,
      }))
      .sort((a, b) => {
        if (b.calls !== a.calls) return b.calls - a.calls;
        if (b.talk_seconds !== a.talk_seconds) return b.talk_seconds - a.talk_seconds;
        return b.follow_ups - a.follow_ups;
      })
      .map((row, index) => ({ ...row, rank: index + 1 }));

    const callOutcomes = [...outcomeCounts.entries()]
      .map(([outcome, count]) => ({ outcome, count }))
      .sort((a, b) => b.count - a.count);

    const overdueList = overdueFollowUps
      .filter((f) => f.leadId && f.agentId)
      .map((f) => {
        const lead = f.leadId as unknown as {
          _id?: { toString(): string };
          companyName?: string;
          contactPerson?: string;
          contactMobile?: string;
          leadCode?: string;
          leadStage?: string;
        };
        const agent = f.agentId as unknown as {
          _id?: { toString(): string };
          name?: string;
          email?: string;
          teamName?: string;
        };
        return {
          id: f._id.toString(),
          lead_id: refId(f.leadId),
          company_name: lead?.companyName ?? '—',
          contact_person: lead?.contactPerson ?? null,
          contact_mobile: lead?.contactMobile ?? null,
          lead_code: lead?.leadCode ?? null,
          lead_stage: lead?.leadStage ?? null,
          next_followup_date: f.nextFollowupDate?.toISOString() ?? null,
          remarks: f.remarks ?? null,
          sequence_number: f.sequenceNumber ?? 1,
          agent_id: refId(f.agentId),
          agent_name: agent?.name ?? '—',
          agent_team_name: agent?.teamName ?? null,
        };
      });

    const alerts: { type: string; message: string; count: number }[] = [];
    if (overdueList.length > 0) {
      alerts.push({
        type: 'overdue_followups',
        message: `${overdueLeadIds.size} overdue follow-up lead(s)`,
        count: overdueLeadIds.size,
      });
    }
    if (dueTodayFollowUps.length > 0) {
      alerts.push({
        type: 'due_today',
        message: `${dueTodayFollowUps.length} follow-up(s) due today`,
        count: dueTodayFollowUps.length,
      });
    }
    if (idleTelecallersToday > 0) {
      alerts.push({
        type: 'idle_agents',
        message: `${idleTelecallersToday} telecaller(s) idle today`,
        count: idleTelecallersToday,
      });
    }
    if (connectedCalls > 0 && recordingCoveragePercent < 80) {
      alerts.push({
        type: 'recording_coverage',
        message: `Recording coverage ${recordingCoveragePercent}% (connected calls)`,
        count: recordingCoveragePercent,
      });
    }

    const payload = {
      range: {
        from: dateKey(rangeStart),
        to: dateKey(new Date(rangeEndExclusive.getTime() - 1)),
        days,
      },
      summary: {
        total_leads: totalLeads,
        total_telecallers: agents.length,
        calls_today: dialsToday.length,
        pending_leads: pendingLeadsTotal,
        calls_last_7_days: dialsRange.length,
        talk_seconds_today: talkSecondsToday,
        talk_seconds_last_7_days: talkSecondsRange,
        avg_form_fill_seconds_today: fillToday.companyAvg,
        avg_form_fill_seconds_last_7_days: fillRange.companyAvg,
        form_fills_today: fillToday.count,
        form_fills_last_7_days: fillRange.count,
        overdue_followups: overdueLeadIds.size,
        due_today_followups: dueTodayFollowUps.length,
        connected_calls_in_range: connectedCalls,
        recordings_uploaded_in_range: recordingsUploaded,
        recording_coverage_percent: recordingCoveragePercent,
        idle_telecallers_today: idleTelecallersToday,
      },
      alerts,
      call_outcomes: callOutcomes,
      leaderboard,
      overdue_followups: overdueList,
      calls_by_day: Object.entries(dayBuckets).map(([date, v]) => ({
        date,
        count: v.count,
        talk_seconds: v.talk_seconds,
      })),
      telecallers,
      pending_leads: pendingLeadsPreview,
    };
    return payload;
  });
}

/** Same My Performance dashboard payload for one telecaller (admin view). */
adminDashboardRouter.get(
  '/telecallers/:userId/performance',
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = String(req.params.userId || '');
      if (!Types.ObjectId.isValid(userId)) throw new AppError(400, 'Invalid user id.');
      const data = await buildTelecallerPerformanceDashboard(userId);
      res.json({ data });
    } catch (err) {
      if (err instanceof Error && err.message === 'Telecaller not found') {
        return next(new AppError(404, err.message));
      }
      next(err);
    }
  }
);

/** Detailed daily report for one telecaller (calls + talk time). */
adminDashboardRouter.get(
  '/telecallers/:userId/daily',
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = String(req.params.userId || '');
      if (!Types.ObjectId.isValid(userId)) throw new AppError(400, 'Invalid user id.');

      const dateRaw = String(req.query.date || dateKey(new Date()));
      const dayStart = parseDayStart(dateRaw);
      if (!dayStart) {
        throw new AppError(400, 'date must be YYYY-MM-DD.');
      }
      const dayEnd = endOfDayExclusive(dayStart);

      const user = await User.findById(userId).select('name email role teamName');
      if (!user) throw new AppError(404, 'Telecaller not found.');

      const calls = await CallRecording.find({
        agentId: userId,
        callStartTime: { $gte: dayStart, $lt: dayEnd },
      })
        .sort({ callStartTime: -1 })
        .populate('leadId', 'companyName contactPerson contactMobile leadCode');

      let talkSeconds = 0;
      const rows = calls.map((c) => {
        const secs = effectiveRecordingTalkSeconds(c);
        talkSeconds += secs;
        const lead = c.leadId as unknown as {
          _id?: { toString(): string };
          companyName?: string;
          contactPerson?: string;
          contactMobile?: string;
          leadCode?: string;
        } | null;
        return {
          id: c._id.toString(),
          lead_id: lead?._id?.toString() ?? c.leadId?.toString(),
          company_name: lead?.companyName ?? '—',
          contact_person: lead?.contactPerson ?? null,
          phone_number: c.phoneNumber,
          lead_code: lead?.leadCode ?? null,
          call_start_time: c.callStartTime.toISOString(),
          call_end_time: c.callEndTime.toISOString(),
          duration_seconds: secs,
          call_outcome: c.callOutcome ?? null,
        };
      });

      res.json({
        data: {
          telecaller: {
            id: user._id.toString(),
            name: user.name,
            email: user.email,
            team_name: user.teamName ?? null,
          },
          date: dateKey(dayStart),
          calls_count: rows.length,
          talk_seconds: talkSeconds,
          calls: rows,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/** Full Daily Sales Telecalling Report for one telecaller. */
adminDashboardRouter.get(
  '/telecallers/:userId/sales-report',
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = String(req.params.userId || '');
      if (!Types.ObjectId.isValid(userId)) throw new AppError(400, 'Invalid user id.');
      const { rangeStart, rangeEndExclusive } = parseReportRange(req.query);
      const report = await buildDailySalesReport(userId, rangeStart, rangeEndExclusive);
      res.json({ data: report });
    } catch (err) {
      if (err instanceof Error && err.message === 'Telecaller not found') {
        return next(new AppError(404, err.message));
      }
      next(err);
    }
  }
);

/** Plain-text copy of one telecaller's daily sales report (WhatsApp-ready). */
adminDashboardRouter.get(
  '/telecallers/:userId/sales-report/text',
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = String(req.params.userId || '');
      if (!Types.ObjectId.isValid(userId)) throw new AppError(400, 'Invalid user id.');
      const { rangeStart, rangeEndExclusive } = parseReportRange(req.query);
      const report = await buildDailySalesReport(userId, rangeStart, rangeEndExclusive);
      const text = formatDailySalesReportText(report);
      res.type('text/plain; charset=utf-8').send(text);
    } catch (err) {
      if (err instanceof Error && err.message === 'Telecaller not found') {
        return next(new AppError(404, err.message));
      }
      next(err);
    }
  }
);

/** Company-wide daily sales reports for all telecallers. */
adminDashboardRouter.get('/sales-reports', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { rangeStart, rangeEndExclusive, fromKey, toKey } = parseReportRange(req.query);
    const reports = await buildAllDailySalesReports(rangeStart, rangeEndExclusive);
    res.json({
      data: {
        date: fromKey,
        date_from: fromKey,
        date_to: toKey,
        date_display: reports[0]?.date_display ?? fromKey,
        reports,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Excel export — one agent or all agents for the day. */
adminDashboardRouter.get('/sales-reports/export', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { rangeStart, rangeEndExclusive, fromKey, toKey } = parseReportRange(req.query);
    const userId = typeof req.query.user_id === 'string' ? req.query.user_id : '';
    let reports;
    if (userId) {
      if (!Types.ObjectId.isValid(userId)) throw new AppError(400, 'Invalid user id.');
      reports = [await buildDailySalesReport(userId, rangeStart, rangeEndExclusive)];
    } else {
      reports = await buildAllDailySalesReports(rangeStart, rangeEndExclusive);
    }
    const buffer = await buildDailySalesReportWorkbook(reports);
    const stamp = fromKey === toKey ? fromKey.replace(/-/g, '') : `${fromKey.replace(/-/g, '')}_${toKey.replace(/-/g, '')}`;
    const namePart = userId && reports[0] ? `_${reports[0].employee.name.replace(/\s+/g, '_')}` : '_All';
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Daily_Sales_Report_${stamp}${namePart}.xlsx"`
    );
    res.send(buffer);
  } catch (err) {
    if (err instanceof Error && err.message === 'Telecaller not found') {
      return next(new AppError(404, err.message));
    }
    next(err);
  }
});

const transferSchema = z.object({
  lead_id: z.string().min(1),
  to_user_id: z.string().min(1),
});

/** Transfer one lead from its current telecaller to another. */
adminDashboardRouter.post('/transfer-lead', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = transferSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues.map((i) => i.message).join('; '));
    }

    const { lead_id: leadId, to_user_id: toUserId } = parsed.data;
    if (!Types.ObjectId.isValid(leadId) || !Types.ObjectId.isValid(toUserId)) {
      throw new AppError(400, 'Invalid lead or user id.');
    }

    const [lead, toUser] = await Promise.all([
      Lead.findById(leadId),
      User.findById(toUserId),
    ]);
    if (!lead) throw new AppError(404, 'Lead not found.');
    if (!toUser || !toUser.isActive) throw new AppError(404, 'Target telecaller not found.');
    if (!['agent', 'manager'].includes(toUser.role)) {
      throw new AppError(400, 'Target user must be a telecaller or team leader.');
    }

    const current = await LeadAssignment.findOne({ leadId, isActive: true });
    if (current && current.agentId.toString() === toUserId) {
      throw new AppError(400, 'Lead is already assigned to this telecaller.');
    }

    if (current) {
      current.isActive = false;
      await current.save();
    }

    const assignment = await LeadAssignment.create(
      assignmentInsertFromLead({
        lead,
        agentId: toUserId,
        assignedBy: req.user!.id,
        assignedAt: new Date(),
      })
    );

    await createAuditLog({
      userId: req.user!.id,
      action: 'admin.lead.transferred',
      entityType: 'lead',
      entityId: leadId,
      metadata: {
        from_user_id: current?.agentId?.toString() ?? null,
        to_user_id: toUserId,
      },
      ipAddress: req.ip,
    });

    res.json({
      data: formatLead(lead, assignment.assignedAt, toUser),
    });
  } catch (err) {
    next(err);
  }
});

const bulkTransferSchema = z.object({
  from_user_id: z.string().min(1),
  to_user_id: z.string().min(1),
  /** all | remaining (never called) | called */
  scope: z.enum(['all', 'remaining', 'called']).optional().default('all'),
});

/** Transfer all (or scoped) leads from one telecaller to another. */
adminDashboardRouter.post('/transfer-leads', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = bulkTransferSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues.map((i) => i.message).join('; '));
    }

    const { from_user_id: fromUserId, to_user_id: toUserId, scope } = parsed.data;
    if (!Types.ObjectId.isValid(fromUserId) || !Types.ObjectId.isValid(toUserId)) {
      throw new AppError(400, 'Invalid from/to user id.');
    }
    if (fromUserId === toUserId) {
      throw new AppError(400, 'Source and destination telecallers must be different.');
    }

    const [fromUser, toUser] = await Promise.all([
      User.findById(fromUserId),
      User.findById(toUserId),
    ]);
    if (!fromUser || !fromUser.isActive) throw new AppError(404, 'Source telecaller not found.');
    if (!toUser || !toUser.isActive) throw new AppError(404, 'Target telecaller not found.');
    if (!['agent', 'manager'].includes(toUser.role)) {
      throw new AppError(400, 'Target user must be a telecaller or team leader.');
    }

    const assignments = await LeadAssignment.find({ agentId: fromUserId, isActive: true }).populate<{
      leadId: { _id: Types.ObjectId; callCount?: number } | null;
    }>('leadId');

    let toMove = assignments.filter((a) => a.leadId);
    if (scope === 'remaining') {
      toMove = toMove.filter((a) => ((a.leadId as { callCount?: number }).callCount ?? 0) === 0);
    } else if (scope === 'called') {
      toMove = toMove.filter((a) => ((a.leadId as { callCount?: number }).callCount ?? 0) > 0);
    }

    let transferredCount = 0;
    for (const current of toMove) {
      current.isActive = false;
      await current.save();
      await LeadAssignment.create({
        leadId: (current.leadId as { _id: Types.ObjectId })._id,
        agentId: toUserId,
        assignedBy: req.user!.id,
        assignedAt: new Date(),
        isActive: true,
        ...listFieldsFromAssignment(current),
      });
      transferredCount += 1;
    }

    await createAuditLog({
      userId: req.user!.id,
      action: 'admin.leads.bulk_transferred',
      entityType: 'user',
      entityId: fromUserId,
      metadata: {
        from_user_id: fromUserId,
        to_user_id: toUserId,
        scope,
        transferred_count: transferredCount,
      },
      ipAddress: req.ip,
    });

    res.json({
      data: {
        from_user_id: fromUserId,
        from_user_name: fromUser.name,
        to_user_id: toUserId,
        to_user_name: toUser.name,
        scope,
        transferred_count: transferredCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Pending leads list (optional filter by telecaller). */
adminDashboardRouter.get('/follow-ups', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const agentId = typeof req.query.agent_id === 'string' ? req.query.agent_id.trim() : '';
    const scope = typeof req.query.scope === 'string' ? req.query.scope.trim() : 'all';
    // pending = overdue + due today (IST); all = every scheduled next date
    const tomorrowStart = new Date(startOfDay().getTime() + 24 * 60 * 60 * 1000);

    const activeAgents = await User.find({
      role: { $in: ['agent', 'manager'] },
      isActive: true,
      ...(agentId && Types.ObjectId.isValid(agentId) ? { _id: new Types.ObjectId(agentId) } : {}),
    })
      .select('_id name teamName')
      .lean();

    const agentIds = activeAgents.map((a) => a._id);
    if (agentIds.length === 0) {
      res.json({ data: [], meta: { overdue_count: 0, due_today_count: 0, upcoming_count: 0 } });
      return;
    }

    const dateFilter: Record<string, unknown> =
      scope === 'pending'
        ? { $ne: null, $lt: tomorrowStart }
        : { $ne: null };

    const followUps = await LeadFollowUp.find({
      agentId: { $in: agentIds },
      nextFollowupDate: dateFilter,
    })
      .sort({ nextFollowupDate: 1, createdAt: -1 })
      .limit(1000)
      .lean();

    const leadIds = [...new Set(followUps.map((f) => f.leadId.toString()))];
    const leads = leadIds.length
      ? await Lead.find({ _id: { $in: leadIds } })
          .select('companyName contactPerson contactMobile leadCode leadStage')
          .lean()
      : [];
    const leadById = new Map(leads.map((l) => [l._id.toString(), l]));
    const agentById = new Map(activeAgents.map((a) => [a._id.toString(), a]));

    const todayStart = startOfDay();
    let overdueCount = 0;
    let dueTodayCount = 0;
    let upcomingCount = 0;

    const data = followUps.map((f) => {
      const lead = leadById.get(f.leadId.toString());
      const agent = agentById.get(f.agentId.toString());
      const due = f.nextFollowupDate ? new Date(f.nextFollowupDate) : null;
      if (due) {
        if (due < todayStart) overdueCount += 1;
        else if (due < tomorrowStart) dueTodayCount += 1;
        else upcomingCount += 1;
      }
      return {
        id: f._id.toString(),
        lead_id: f.leadId.toString(),
        company_name: lead?.companyName ?? '—',
        contact_person: lead?.contactPerson ?? null,
        contact_mobile: lead?.contactMobile ?? null,
        lead_code: lead?.leadCode ?? null,
        lead_stage: lead?.leadStage ?? null,
        next_followup_date: f.nextFollowupDate?.toISOString() ?? null,
        remarks: f.remarks ?? null,
        sequence_number: f.sequenceNumber ?? 1,
        agent_id: f.agentId.toString(),
        agent_name: agent?.name ?? '—',
        agent_team_name: agent?.teamName ?? null,
      };
    });

    res.json({
      data,
      meta: {
        overdue_count: overdueCount,
        due_today_count: dueTodayCount,
        upcoming_count: upcomingCount,
        total: data.length,
        scope: scope === 'pending' ? 'pending' : 'all',
      },
    });
  } catch (err) {
    next(err);
  }
});

adminDashboardRouter.get('/pending-leads', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const agentId = typeof req.query.agent_id === 'string' ? req.query.agent_id : null;
    const limitRaw = Number(req.query.limit ?? 40);
    const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 40;
    const tomorrowStart = endOfDayExclusive(startOfDay());

    const match: Record<string, unknown> = { isActive: true };
    if (agentId && Types.ObjectId.isValid(agentId)) {
      match.agentId = new Types.ObjectId(agentId);
    }

    const pendingKeys = await loadPendingAssignmentKeys(match, tomorrowStart, limit);
    const data = await hydratePendingLeads(pendingKeys);

    res.json({ data });
  } catch (err) {
    next(err);
  }
});
