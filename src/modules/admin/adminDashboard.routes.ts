import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { CallRecording, Lead, LeadAssignment, LeadFollowUp, User } from '../../models';
import { AuthRequest } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import { createAuditLog, formatLead } from '../../utils/helpers';
import { toApiRole } from '../../utils/roleMapping';

export const adminDashboardRouter = Router();

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

/** Calendar day in the server's local timezone (not UTC). */
function dateKey(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Company-wide dashboard: summary + per-telecaller report + 7-day call trend. */
adminDashboardRouter.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const todayStart = startOfDay();
    const weekStart = daysAgo(6);

    const agents = await User.find({
      role: { $in: ['agent', 'manager'] },
      isActive: true,
    })
      .select('name email role teamId teamName')
      .sort({ name: 1 });

    const agentIds = agents.map((a) => a._id);

    const [assignments, callsToday, callsWeek, followUpsWithNext] = await Promise.all([
      LeadAssignment.find({ isActive: true }).select('leadId agentId'),
      CallRecording.find({ callStartTime: { $gte: todayStart } }).select('agentId leadId'),
      CallRecording.find({ callStartTime: { $gte: weekStart } }).select('agentId callStartTime'),
      LeadFollowUp.find({ nextFollowupDate: { $ne: null, $lte: new Date() } }).select('leadId'),
    ]);

    const leadIds = [...new Set(assignments.map((a) => a.leadId.toString()))];
    const calledLeadIds = new Set(
      (await CallRecording.distinct('leadId', { leadId: { $in: leadIds } })).map((id) => id.toString())
    );

    // Pending = assigned lead that has never been called, or overdue scheduled follow-up.
    const overdueLeadIds = new Set(followUpsWithNext.map((f) => f.leadId.toString()));
    const pendingLeadIds = new Set<string>();
    for (const a of assignments) {
      const id = a.leadId.toString();
      if (!calledLeadIds.has(id) || overdueLeadIds.has(id)) pendingLeadIds.add(id);
    }

    const assignedByAgent = new Map<string, number>();
    const pendingByAgent = new Map<string, number>();
    for (const a of assignments) {
      const aid = a.agentId.toString();
      assignedByAgent.set(aid, (assignedByAgent.get(aid) ?? 0) + 1);
      if (pendingLeadIds.has(a.leadId.toString())) {
        pendingByAgent.set(aid, (pendingByAgent.get(aid) ?? 0) + 1);
      }
    }

    const callsTodayByAgent = new Map<string, number>();
    for (const c of callsToday) {
      const aid = c.agentId.toString();
      callsTodayByAgent.set(aid, (callsTodayByAgent.get(aid) ?? 0) + 1);
    }

    const callsWeekByAgent = new Map<string, number>();
    const dayBuckets: Record<string, number> = {};
    for (let i = 6; i >= 0; i--) {
      dayBuckets[dateKey(daysAgo(i))] = 0;
    }
    for (const c of callsWeek) {
      const aid = c.agentId.toString();
      callsWeekByAgent.set(aid, (callsWeekByAgent.get(aid) ?? 0) + 1);
      const key = dateKey(new Date(c.callStartTime));
      if (key in dayBuckets) dayBuckets[key] += 1;
    }

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
        calls_last_7_days: callsWeekByAgent.get(id) ?? 0,
      };
    });

    res.json({
      data: {
        summary: {
          total_leads: leadIds.length,
          total_telecallers: agents.length,
          calls_today: callsToday.length,
          pending_leads: pendingLeadIds.size,
          calls_last_7_days: callsWeek.length,
        },
        calls_by_day: Object.entries(dayBuckets).map(([date, count]) => ({ date, count })),
        telecallers,
      },
    });
  } catch (err) {
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

    const assignment = await LeadAssignment.create({
      leadId,
      agentId: toUserId,
      assignedBy: req.user!.id,
      assignedAt: new Date(),
      isActive: true,
    });

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
adminDashboardRouter.get('/pending-leads', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const agentId = typeof req.query.agent_id === 'string' ? req.query.agent_id : null;

    const assignmentFilter: Record<string, unknown> = { isActive: true };
    if (agentId) assignmentFilter.agentId = agentId;

    const assignments = await LeadAssignment.find(assignmentFilter)
      .populate('leadId')
      .populate('agentId', 'name email teamName');

    const leadIds = assignments.map((a) => a.leadId).filter(Boolean).map((l) => (l as { _id: Types.ObjectId })._id);
    const called = new Set(
      (await CallRecording.distinct('leadId', { leadId: { $in: leadIds } })).map((id) => id.toString())
    );
    const overdue = new Set(
      (
        await LeadFollowUp.find({
          leadId: { $in: leadIds },
          nextFollowupDate: { $ne: null, $lte: new Date() },
        }).select('leadId')
      ).map((f) => f.leadId.toString())
    );

    const data = assignments
      .filter((a) => a.leadId && a.agentId)
      .filter((a) => {
        const id = (a.leadId as { _id: Types.ObjectId })._id.toString();
        return !called.has(id) || overdue.has(id);
      })
      .map((a) => {
        const lead = a.leadId as unknown as import('../../models/Lead').ILead;
        const agent = a.agentId as unknown as { _id: Types.ObjectId; name: string; email: string; teamName?: string };
        const id = lead._id.toString();
        return {
          ...formatLead(lead, a.assignedAt, agent as never),
          pending_reason: !called.has(id) ? 'never_called' : 'followup_due',
        };
      });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});
