import { Types } from 'mongoose';
import { Lead, User } from '../../models';
import { ILead } from '../../models/Lead';
import { formatLead } from '../../utils/helpers';
import {
  isCalledLead,
  isRawLead,
  leadMatchesSearch,
  loadAssignmentLeadRows,
} from '../../services/assignmentLeadLite';

function matchesFieldFilters(lead: ILead, query: Record<string, unknown>): boolean {
  if (typeof query.state === 'string' && query.state && (lead.state ?? '') !== query.state) return false;
  if (typeof query.district === 'string' && query.district && (lead.district ?? '') !== query.district) {
    return false;
  }
  if (typeof query.lead_status === 'string' && query.lead_status && (lead.leadStatus ?? '') !== query.lead_status) {
    return false;
  }
  if (typeof query.lead_stage === 'string' && query.lead_stage && (lead.leadStage ?? '') !== query.lead_stage) {
    return false;
  }
  if (typeof query.priority === 'string' && query.priority && (lead.priority ?? '') !== query.priority) {
    return false;
  }
  if (
    typeof query.customer_type === 'string' &&
    query.customer_type &&
    (lead.customerType ?? '') !== query.customer_type
  ) {
    return false;
  }
  return true;
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

  const rows = await loadAssignmentLeadRows(assignmentMatch);
  const search = typeof query.search === 'string' ? query.search : undefined;
  const filtered = rows.filter((row) => matchesFieldFilters(row.lead, query) && leadMatchesSearch(row.lead, search));

  const remainingRows = filtered.filter((row) => isRawLead(row.lead));
  const calledRows = filtered.filter((row) => isCalledLead(row.lead) && (row.lead.callCount ?? 0) > 0);
  const tabRows = tab === 'called' ? calledRows : remainingRows;

  const sorted = [...tabRows];
  if (tab === 'called') {
    sorted.sort((a, b) => {
      const la = (a.lead.lastCalledAt ?? a.assignedAt).getTime();
      const lb = (b.lead.lastCalledAt ?? b.assignedAt).getTime();
      if (lb !== la) return lb - la;
      return String(b.leadId).localeCompare(String(a.leadId));
    });
  } else {
    sorted.sort((a, b) => {
      const rowa = a.lead.importRowNumber ?? 999999999;
      const rowb = b.lead.importRowNumber ?? 999999999;
      if (rowa !== rowb) return rowa - rowb;
      const ca = (a.lead.createdAt ?? a.assignedAt).getTime();
      const cb = (b.lead.createdAt ?? b.assignedAt).getTime();
      if (ca !== cb) return ca - cb;
      return String(a.leadId).localeCompare(String(b.leadId));
    });
  }

  const total = sorted.length;
  const pageKeys = sorted.slice(skip, skip + limit);
  const leadIds = pageKeys.map((r) => r.leadId);
  const agentIds = [...new Set(pageKeys.map((r) => String(r.agentId)))].map((id) => new Types.ObjectId(id));

  const [leadDocs, agents] = await Promise.all([
    leadIds.length === 0 ? Promise.resolve([] as ILead[]) : Lead.find({ _id: { $in: leadIds } }).lean<ILead[]>(),
    agentIds.length === 0
      ? Promise.resolve([])
      : User.find({ _id: { $in: agentIds } }).select('name email teamName').lean(),
  ]);

  const leadById = new Map(leadDocs.map((l) => [String(l._id), l]));
  const agentById = new Map(agents.map((a) => [String(a._id), a]));

  const data = pageKeys
    .map((row) => {
      const lead = leadById.get(String(row.leadId));
      if (!lead) return null;
      const agent = agentById.get(String(row.agentId));
      const formatted = formatLead(lead as ILead, row.assignedAt, agent as never);
      if (!formatted.sales_executive && agent?.name) {
        formatted.sales_executive = agent.name;
      }
      return formatted;
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  const meta: {
    total: number;
    page: number;
    total_pages: number;
    remaining_count?: number;
    called_count?: number;
    tab: 'remaining' | 'called';
  } = {
    total,
    page,
    total_pages: Math.max(1, Math.ceil(total / Math.max(1, limit))),
    tab,
  };
  if (includeCounts) {
    meta.remaining_count = remainingRows.length;
    meta.called_count = calledRows.length;
  }

  return { data, meta };
}
