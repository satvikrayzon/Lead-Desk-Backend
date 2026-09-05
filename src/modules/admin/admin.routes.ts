import { Router, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { Lead, LeadAssignment, Team, User } from '../../models';
import { AuthRequest, requireRoles } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import { createAuditLog, formatLead } from '../../utils/helpers';
import { buildLeadTrackerWorkbook, loadFollowUpsByLeadId } from '../../services/excelExportService';
import { getNextLeadCode } from '../../services/leadCodeService';
import { ILead } from '../../models/Lead';
import { adminUsersRouter } from './adminUsers.routes';
import { adminTeamsRouter } from './adminTeams.routes';
import { adminDashboardRouter } from './adminDashboard.routes';

export const adminRouter = Router();

adminRouter.use(requireRoles('admin', 'manager'));

adminRouter.use('/users', adminUsersRouter);
adminRouter.use('/teams', adminTeamsRouter);
adminRouter.use('/dashboard', adminDashboardRouter);

const createLeadSchema = z.object({
  company_name: z.string().min(1),
  contact_person: z.string().optional(),
  contact_mobile: z.string().min(5),
  contact_email: z.string().optional(),
  state: z.string().optional(),
  district: z.string().optional(),
  address: z.string().optional(),
  assign_to_user_id: z.string().min(1),
});

/** Create a new lead and assign it to a telecaller. */
adminRouter.post('/leads', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = createLeadSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues.map((i) => i.message).join('; '));
    }

    const {
      company_name: companyName,
      contact_person: contactPerson,
      contact_mobile: contactMobile,
      contact_email: contactEmail,
      state,
      district,
      address,
      assign_to_user_id: assignToUserId,
    } = parsed.data;

    if (!Types.ObjectId.isValid(assignToUserId)) {
      throw new AppError(400, 'Invalid assign_to_user_id.');
    }

    const agent = await User.findById(assignToUserId);
    if (!agent || !agent.isActive) throw new AppError(404, 'Target telecaller not found.');
    if (!['agent', 'manager'].includes(agent.role)) {
      throw new AppError(400, 'Target user must be a telecaller or team leader.');
    }

    const leadCode = await getNextLeadCode(agent.name, assignToUserId);

    const lead = await Lead.create({
      companyName: companyName.trim(),
      company: companyName.trim(),
      name: (contactPerson?.trim() || companyName.trim()),
      contactPerson: contactPerson?.trim() || undefined,
      contactMobile: contactMobile.trim(),
      phoneNumber: contactMobile.trim(),
      contactEmail: contactEmail?.trim() || undefined,
      state: state?.trim() || undefined,
      district: district?.trim() || undefined,
      address: address?.trim() || undefined,
      leadCode,
      leadDate: new Date(),
      salesExecutive: agent.name,
      teamLeader: agent.teamName || undefined,
      leadStatus: 'open',
      leadStage: 'not_contacted',
      status: 'new',
      callCount: 0,
    });

    const assignment = await LeadAssignment.create({
      leadId: lead._id,
      agentId: assignToUserId,
      assignedBy: req.user!.id,
      assignedAt: new Date(),
      isActive: true,
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'admin.lead.created',
      entityType: 'lead',
      entityId: lead._id.toString(),
      metadata: { assign_to_user_id: assignToUserId },
      ipAddress: req.ip,
    });

    res.status(201).json({
      data: formatLead(lead, assignment.assignedAt, agent),
    });
  } catch (err) {
    next(err);
  }
});

function buildLeadFilter(query: AuthRequest['query']) {
  const filter: Record<string, unknown> = {};
  if (query.state && typeof query.state === 'string') filter.state = query.state;
  if (query.district && typeof query.district === 'string') filter.district = query.district;
  if (query.lead_status && typeof query.lead_status === 'string') filter.leadStatus = query.lead_status;
  if (query.lead_stage && typeof query.lead_stage === 'string') filter.leadStage = query.lead_stage;
  if (query.priority && typeof query.priority === 'string') filter.priority = query.priority;
  if (query.customer_type && typeof query.customer_type === 'string') filter.customerType = query.customer_type;
  return filter;
}

type PopulatedAgent = {
  _id: { toString(): string };
  name: string;
  teamName?: string;
  teamId?: { toString(): string } | null;
};

async function fetchExportRows(query: AuthRequest['query'], options: { applyTab?: boolean } = {}) {
  const applyTab = options.applyTab !== false;
  const leadFilter = buildLeadFilter(query);
  const search = typeof query.search === 'string' ? query.search.trim().toLowerCase() : '';
  const teamId = typeof query.team_id === 'string' ? query.team_id : '';
  const salesExecutiveId =
    typeof query.sales_executive_id === 'string' ? query.sales_executive_id : '';
  const tab = typeof query.tab === 'string' ? query.tab : '';

  const assignments = await LeadAssignment.find({ isActive: true }).populate<{
    leadId: ILead;
    agentId: PopulatedAgent;
  }>([
    { path: 'leadId', match: leadFilter },
    { path: 'agentId', select: 'name teamName teamId' },
  ]);

  let rows = assignments
    .filter((a) => a.leadId && a.agentId)
    .map((a) => {
      const agent = a.agentId as PopulatedAgent;
      return {
        lead: a.leadId as ILead,
        salesExecutive: agent.name,
        teamLeader: agent.teamName ?? '',
        agentId: agent._id.toString(),
        teamId: agent.teamId?.toString() ?? null,
      };
    });

  if (teamId) {
    rows = rows.filter((r) => r.teamId === teamId);
  }

  if (salesExecutiveId) {
    rows = rows.filter((r) => r.agentId === salesExecutiveId);
  }

  if (search) {
    rows = rows.filter(({ lead }) => {
      const company = (lead.companyName ?? lead.company ?? lead.name).toLowerCase();
      return (
        company.includes(search) ||
        (lead.contactPerson ?? '').toLowerCase().includes(search) ||
        (lead.state ?? '').toLowerCase().includes(search) ||
        (lead.city ?? '').toLowerCase().includes(search) ||
        (lead.district ?? '').toLowerCase().includes(search)
      );
    });
  }

  if (applyTab) {
    if (tab === 'called') {
      rows = rows.filter((r) => (r.lead.callCount ?? 0) > 0);
    } else if (tab === 'remaining' || tab === 'raw' || !tab) {
      // Default: raw / not contacted
      rows = rows.filter((r) => (r.lead.callCount ?? 0) === 0);
    }
  }

  return rows;
}

adminRouter.get('/leads/filters', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const [states, districts, telecallers, teams] = await Promise.all([
      Lead.distinct('state', { state: { $ne: null } }),
      Lead.distinct('district', { district: { $ne: null } }),
      User.find({ role: { $in: ['agent', 'manager'] }, isActive: true })
        .select('name teamId teamName role')
        .sort({ name: 1 }),
      Team.find().select('name').sort({ name: 1 }),
    ]);

    res.json({
      data: {
        states: states.filter(Boolean).sort(),
        districts: districts.filter(Boolean).sort(),
        sales_executives: telecallers.map((a) => ({
          id: a._id.toString(),
          name: a.name,
          team_id: a.teamId?.toString() ?? null,
          team_name: a.teamName ?? null,
          role: a.role,
        })),
        teams: teams.map((t) => ({ id: t._id.toString(), name: t.name })),
      },
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/leads/export', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const rows = await fetchExportRows(req.query);
    const followUpsByLead = await loadFollowUpsByLeadId(rows.map((r) => r.lead._id));
    const buffer = await buildLeadTrackerWorkbook(
      rows.map(({ lead, salesExecutive, teamLeader }) => ({
        lead,
        salesExecutive,
        teamLeader,
        followUps: followUpsByLead.get(lead._id.toString()) ?? [],
      }))
    );
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Sales_Lead_Tracker.xlsx"');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/leads', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = 50;

    // Counts for both tabs use the same filters (minus tab).
    const allRows = await fetchExportRows(req.query, { applyTab: false });
    const remainingCount = allRows.filter((r) => (r.lead.callCount ?? 0) === 0).length;
    const calledCount = allRows.filter((r) => (r.lead.callCount ?? 0) > 0).length;

    const tab = typeof req.query.tab === 'string' ? req.query.tab : 'remaining';
    const rows =
      tab === 'called'
        ? allRows.filter((r) => (r.lead.callCount ?? 0) > 0)
        : allRows.filter((r) => (r.lead.callCount ?? 0) === 0);

    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const slice = rows.slice((page - 1) * limit, page * limit);

    const data = await Promise.all(
      slice.map(async ({ lead, salesExecutive }) => {
        const assignment = await LeadAssignment.findOne({ leadId: lead._id, isActive: true });
        const agent = assignment
          ? await User.findById(assignment.agentId).select('name email teamName')
          : null;
        const formatted = formatLead(lead, assignment?.assignedAt ?? lead.createdAt, agent);
        if (!formatted.sales_executive) formatted.sales_executive = salesExecutive;
        return formatted;
      })
    );

    res.json({
      data,
      meta: {
        total,
        page,
        total_pages: totalPages,
        remaining_count: remainingCount,
        called_count: calledCount,
        tab: tab === 'called' ? 'called' : 'remaining',
      },
    });
  } catch (err) {
    next(err);
  }
});
