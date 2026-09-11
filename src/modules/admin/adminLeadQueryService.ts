import { FilterQuery, Types } from 'mongoose';
import { Lead, User } from '../../models';
import { ILead } from '../../models/Lead';
import { formatLead } from '../../utils/helpers';
import { calledTabMongo, loadAssignmentIndex, rawTabMongo } from '../../services/assignmentLeadLite';

function applyLeadFieldFilters(match: FilterQuery<ILead>, query: Record<string, unknown>) {
  if (typeof query.state === 'string' && query.state) match.state = query.state;
  if (typeof query.district === 'string' && query.district) match.district = query.district;
  if (typeof query.lead_status === 'string' && query.lead_status) match.leadStatus = query.lead_status;
  if (typeof query.lead_stage === 'string' && query.lead_stage) match.leadStage = query.lead_stage;
  if (typeof query.priority === 'string' && query.priority) match.priority = query.priority;
  if (typeof query.customer_type === 'string' && query.customer_type) match.customerType = query.customer_type;
}

function searchMongo(search?: string): FilterQuery<ILead> | null {
  if (!search?.trim()) return null;
  const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = { $regex: term, $options: 'i' };
  return {
    $or: [
      { name: rx },
      { companyName: rx },
      { company: rx },
      { contactPerson: rx },
      { contactMobile: rx },
      { phoneNumber: rx },
      { state: rx },
      { district: rx },
      { city: rx },
      { leadCode: rx },
    ],
  };
}

export async function queryAdminLeadsPage(input: {
  query: Record<string, unknown>;
  page: number;
  limit: number;
  includeCounts?: boolean;
}): Promise<{
  data: ReturnType<typeof formatLead>[];
  meta: {
    total: number;
    page: number;
    total_pages: number;
    remaining_count?: number;
    called_count?: number;
    tab: 'remaining' | 'called';
  };
}> {
  const { query, page, limit } = input;
  const includeCounts = input.includeCounts !== false;
  const skip = (page - 1) * limit;
  const tab = query.tab === 'called' ? 'called' : 'remaining';

  const assignmentMatch: Record<string, unknown> = { isActive: true };
  const salesExecutiveId =
    typeof query.sales_executive_id === 'string' ? query.sales_executive_id.trim() : '';
  if (salesExecutiveId && Types.ObjectId.isValid(salesExecutiveId)) {
    assignmentMatch.agentId = new Types.ObjectId(salesExecutiveId);
  }

  const teamId = typeof query.team_id === 'string' ? query.team_id.trim() : '';
  if (teamId && Types.ObjectId.isValid(teamId)) {
    const agents = await User.find({
      teamId: new Types.ObjectId(teamId),
      isActive: true,
      role: { $in: ['agent', 'manager'] },
    })
      .select('_id')
      .lean();
    const teamAgentIds = agents.map((a) => a._id as Types.ObjectId);
    if (teamAgentIds.length === 0) {
      return {
        data: [],
        meta: {
          total: 0,
          page,
          total_pages: 1,
          remaining_count: includeCounts ? 0 : undefined,
          called_count: includeCounts ? 0 : undefined,
          tab,
        },
      };
    }
    if (assignmentMatch.agentId) {
      const only = assignmentMatch.agentId as Types.ObjectId;
      if (!teamAgentIds.some((id) => id.equals(only))) {
        return {
          data: [],
          meta: {
            total: 0,
            page,
            total_pages: 1,
            remaining_count: includeCounts ? 0 : undefined,
            called_count: includeCounts ? 0 : undefined,
            tab,
          },
        };
      }
    } else {
      assignmentMatch.agentId = { $in: teamAgentIds };
    }
  }

  const assignments = await loadAssignmentIndex(assignmentMatch);
  if (assignments.length === 0) {
    return {
      data: [],
      meta: {
        total: 0,
        page,
        total_pages: 1,
        remaining_count: includeCounts ? 0 : undefined,
        called_count: includeCounts ? 0 : undefined,
        tab,
      },
    };
  }

  const assignByLead = new Map(assignments.map((a) => [String(a.leadId), a]));
  const leadIds = assignments.map((a) => a.leadId);
  const search = searchMongo(typeof query.search === 'string' ? query.search : undefined);

  const base: FilterQuery<ILead> = { _id: { $in: leadIds } };
  applyLeadFieldFilters(base, query);

  const extras: FilterQuery<ILead>[] = [];
  if (search) extras.push(search);
  const withExtras = (tabMatch: FilterQuery<ILead>): FilterQuery<ILead> => {
    const parts = [base, tabMatch, ...extras];
    return parts.length === 1 ? parts[0] : { $and: parts };
  };

  const remainingMatch = withExtras(rawTabMongo());
  const calledMatch = withExtras(calledTabMongo());
  const tabMatch = tab === 'called' ? calledMatch : remainingMatch;
  const [total, pageLeads, remainingCount, calledCount] = await Promise.all([
    Lead.countDocuments(tabMatch),
    tab === 'called'
      ? Lead.find(tabMatch).sort({ lastCalledAt: -1, _id: -1 }).skip(skip).limit(limit).lean<ILead[]>()
      : Lead.find(tabMatch).sort({ importRowNumber: 1, createdAt: 1, _id: 1 }).skip(skip).limit(limit).lean<ILead[]>(),
    includeCounts ? Lead.countDocuments(remainingMatch) : Promise.resolve(0),
    includeCounts ? Lead.countDocuments(calledMatch) : Promise.resolve(0),
  ]);

  const agentIds = [
    ...new Set(
      pageLeads
        .map((l) => assignByLead.get(String(l._id))?.agentId)
        .filter((id): id is Types.ObjectId => Boolean(id))
        .map((id) => String(id))
    ),
  ].map((id) => new Types.ObjectId(id));

  const agents =
    agentIds.length === 0
      ? []
      : await User.find({ _id: { $in: agentIds } }).select('name email teamName').lean();
  const agentById = new Map(agents.map((a) => [String(a._id), a]));

  const data = pageLeads
    .map((lead) => {
      const row = assignByLead.get(String(lead._id));
      if (!row) return null;
      const agent = agentById.get(String(row.agentId));
      const formatted = formatLead(lead as ILead, row.assignedAt, agent as never);
      if (!formatted.sales_executive && agent?.name) formatted.sales_executive = agent.name;
      return formatted;
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  return {
    data,
    meta: {
      total,
      page,
      total_pages: Math.max(1, Math.ceil(total / Math.max(1, limit))),
      tab,
      remaining_count: includeCounts ? remainingCount : undefined,
      called_count: includeCounts ? calledCount : undefined,
    },
  };
}
