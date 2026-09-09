import { Router, Response, NextFunction } from 'express';
import { CallRecording, LeadAssignment, LeadFollowUp, User } from '../../models';
import { AuthRequest } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import {
  buildDailySalesReport,
  buildDailySalesReportWorkbook,
  formatDailySalesReportText,
  parseReportRange,
} from '../../services/dailySalesReportService';

export const meDashboardRouter = Router();

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function daysAgo(n: number) {
  const d = startOfDay();
  d.setDate(d.getDate() - n);
  return d;
}

function dateKey(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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

/** Logged-in telecaller / team leader personal performance dashboard. */
meDashboardRouter.get('/dashboard', async (req: AuthRequest, res: Response, next: NextFunction) => {
  const startedAt = Date.now();
  try {
    const userId = req.user?.id;
    console.log('[me/dashboard] request', {
      userId,
      email: req.user?.email,
      role: req.user?.role,
      name: req.user?.name,
    });

    if (!userId) {
      console.error('[me/dashboard] missing req.user.id');
      throw new AppError(401, 'Authentication required.');
    }

    // Must include isActive in select — otherwise it is undefined and
    // `!user.isActive` falsely returns 404 for every user.
    const user = await User.findById(userId).select('name email role teamName isActive');
    console.log('[me/dashboard] user lookup', {
      userId,
      found: Boolean(user),
      isActive: user?.isActive,
      dbId: user?._id?.toString(),
      dbEmail: user?.email,
      dbRole: user?.role,
    });

    if (!user) {
      console.error('[me/dashboard] user document missing for id', userId);
      throw new AppError(404, 'User not found.');
    }
    if (user.isActive === false) {
      console.error('[me/dashboard] user inactive', { userId, email: user.email });
      throw new AppError(404, 'User not found.');
    }

    const todayStart = startOfDay();
    const weekStart = daysAgo(6);
    console.log('[me/dashboard] window', {
      todayStart: todayStart.toISOString(),
      weekStart: weekStart.toISOString(),
    });

    const [assignments, callsToday, callsWeek, formFillsToday, formFillsWeek, followUpsToday, followUpsWeek] =
      await Promise.all([
        LeadAssignment.find({ agentId: userId, isActive: true }).select('leadId'),
        CallRecording.find({ agentId: userId, callStartTime: { $gte: todayStart } })
          .select('leadId phoneNumber durationSeconds callStartTime callEndTime callOutcome')
          .populate('leadId', 'companyName contactPerson leadCode')
          .sort({ callStartTime: -1 }),
        CallRecording.find({ agentId: userId, callStartTime: { $gte: weekStart } }).select(
          'callStartTime durationSeconds'
        ),
        LeadFollowUp.find({
          agentId: userId,
          createdAt: { $gte: todayStart },
          formFillSeconds: { $ne: null, $gte: 0 },
        }).select('formFillSeconds'),
        LeadFollowUp.find({
          agentId: userId,
          createdAt: { $gte: weekStart },
          formFillSeconds: { $ne: null, $gte: 0 },
        }).select('formFillSeconds'),
        LeadFollowUp.countDocuments({ agentId: userId, createdAt: { $gte: todayStart } }),
        LeadFollowUp.countDocuments({ agentId: userId, createdAt: { $gte: weekStart } }),
      ]);

    console.log('[me/dashboard] counts', {
      assignments: assignments.length,
      callsToday: callsToday.length,
      callsWeek: callsWeek.length,
      followUpsToday,
      followUpsWeek,
      formFillsToday: formFillsToday.length,
      formFillsWeek: formFillsWeek.length,
    });

    const leadIds = assignments.map((a) => a.leadId);
    const calledLeadIds = new Set(
      (await CallRecording.distinct('leadId', { leadId: { $in: leadIds } })).map((id) => id.toString())
    );
    const overdueLeadIds = new Set(
      (
        await LeadFollowUp.find({
          leadId: { $in: leadIds },
          nextFollowupDate: { $ne: null, $lte: new Date() },
        }).select('leadId')
      ).map((f) => f.leadId.toString())
    );

    let pendingLeads = 0;
    for (const a of assignments) {
      const id = a.leadId.toString();
      if (!calledLeadIds.has(id) || overdueLeadIds.has(id)) pendingLeads += 1;
    }

    let talkSecondsToday = 0;
    for (const c of callsToday) {
      talkSecondsToday += Math.max(0, c.durationSeconds || 0);
    }

    const dayBuckets: Record<string, { count: number; talk_seconds: number }> = {};
    for (let i = 6; i >= 0; i--) {
      dayBuckets[dateKey(daysAgo(i))] = { count: 0, talk_seconds: 0 };
    }
    let talkSecondsWeek = 0;
    for (const c of callsWeek) {
      const secs = Math.max(0, c.durationSeconds || 0);
      talkSecondsWeek += secs;
      const key = dateKey(new Date(c.callStartTime));
      if (key in dayBuckets) {
        dayBuckets[key].count += 1;
        dayBuckets[key].talk_seconds += secs;
      }
    }

    const fillToday = avgFormFill(formFillsToday);
    const fillWeek = avgFormFill(formFillsWeek);

    const recentCalls = callsToday.slice(0, 25).map((c) => {
      const lead = c.leadId as unknown as {
        _id?: { toString(): string };
        companyName?: string;
        contactPerson?: string;
        leadCode?: string;
      } | null;
      return {
        id: c._id.toString(),
        lead_id: lead?._id?.toString() ?? c.leadId?.toString(),
        company_name: lead?.companyName ?? '—',
        contact_person: lead?.contactPerson ?? null,
        lead_code: lead?.leadCode ?? null,
        phone_number: c.phoneNumber,
        call_start_time: c.callStartTime.toISOString(),
        call_end_time: c.callEndTime?.toISOString() ?? null,
        duration_seconds: Math.max(0, c.durationSeconds || 0),
        call_outcome: c.callOutcome ?? null,
      };
    });

    console.log('[me/dashboard] ok', {
      userId,
      pendingLeads,
      talkSecondsToday,
      talkSecondsWeek,
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
          assigned_leads: assignments.length,
          pending_leads: pendingLeads,
          calls_today: callsToday.length,
          calls_last_7_days: callsWeek.length,
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
    const stamp = fromKey === toKey ? fromKey.replace(/-/g, '') : `${fromKey.replace(/-/g, '')}_${toKey.replace(/-/g, '')}`;
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
