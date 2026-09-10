import { PipelineStage, Types } from 'mongoose';
import { Lead, LeadAssignment, User } from '../../models';
import { ILead } from '../../models/Lead';
import { formatLead } from '../../utils/helpers';

const LEAD_LITE_PROJECT = {
  _id: 1,
  name: 1,
  phoneNumber: 1,
  companyName: 1,
  company: 1,
  contactPerson: 1,
  contactMobile: 1,
  state: 1,
  district: 1,
  city: 1,
  leadCode: 1,
  leadStatus: 1,
  leadStage: 1,
  priority: 1,
  customerType: 1,
  product: 1,
  callCount: 1,
  lastCalledAt: 1,
  createdAt: 1,
  importRowNumber: 1,
};

function rawTabMatch(): Record<string, unknown> {
  return {
    $or: [{ 'lead.callCount': { $exists: false } }, { 'lead.callCount': null }, { 'lead.callCount': 0 }],
  };
}

function calledTabMatch(): Record<string, unknown> {
  return { 'lead.callCount': { $gt: 0 } };
}

function buildLeadFieldMatch(query: Record<string, unknown>): Record<string, unknown> {
  const match: Record<string, unknown> = {};
  if (typeof query.state === 'string' && query.state) match['lead.state'] = query.state;
  if (typeof query.district === 'string' && query.district) match['lead.district'] = query.district;
  if (typeof query.lead_status === 'string' && query.lead_status) match['lead.leadStatus'] = query.lead_status;
  if (typeof query.lead_stage === 'string' && query.lead_stage) match['lead.leadStage'] = query.lead_stage;
  if (typeof query.priority === 'string' && query.priority) match['lead.priority'] = query.priority;
  if (typeof query.customer_type === 'string' && query.customer_type) {
    match['lead.customerType'] = query.customer_type;
  }
  return match;
}

function buildSearchMatch(search?: string): Record<string, unknown> | null {
  if (!search?.trim()) return null;
  const term = search.trim();
  const rx = { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  return {
    $or: [
      { 'lead.name': rx },
      { 'lead.companyName': rx },
      { 'lead.company': rx },
      { 'lead.contactPerson': rx },
      { 'lead.contactMobile': rx },
      { 'lead.phoneNumber': rx },
      { 'lead.state': rx },
      { 'lead.district': rx },
      { 'lead.city': rx },
      { 'lead.leadCode': rx },
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
  const tabMatch = tab === 'called' ? calledTabMatch() : rawTabMatch();

  const assignmentMatch: Record<string, unknown> = { isActive: true };
  const salesExecutiveId =
    typeof query.sales_executive_id === 'string' ? query.sales_executive_id.trim() : '';
  if (salesExecutiveId && Types.ObjectId.isValid(salesExecutiveId)) {
    assignmentMatch.agentId = new Types.ObjectId(salesExecutiveId);
  }

  const teamId = typeof query.team_id === 'string' ? query.team_id.trim() : '';
  let teamAgentIds: Types.ObjectId[] | null = null;
  if (teamId && Types.ObjectId.isValid(teamId)) {
    const agents = await User.find({
      teamId: new Types.ObjectId(teamId),
      isActive: true,
      role: { $in: ['agent', 'manager'] },
    })
      .select('_id')
      .lean();
    teamAgentIds = agents.map((a) => a._id as Types.ObjectId);
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

  const extraFilters: Record<string, unknown>[] = [];
  const fieldMatch = buildLeadFieldMatch(query);
  if (Object.keys(fieldMatch).length) extraFilters.push(fieldMatch);
  const searchMatch = buildSearchMatch(typeof query.search === 'string' ? query.search : undefined);
  if (searchMatch) extraFilters.push(searchMatch);

  const facetBranches: Record<string, object[]> = {
    total: [{ $match: tabMatch }, { $count: 'n' }],
    pageKeys: [
      { $match: tabMatch },
      ...(tab === 'called'
        ? [
            {
              $addFields: {
                _lastCall: { $ifNull: ['$lead.lastCalledAt', '$assignedAt'] },
              },
            },
            {
              $sort: {
                _lastCall: -1 as const,
                assignedAt: -1 as const,
                'lead._id': -1 as const,
              },
            },
          ]
        : [
            {
              $addFields: {
                _row: { $ifNull: ['$lead.importRowNumber', 999999999] },
                _created: { $ifNull: ['$lead.createdAt', '$assignedAt'] },
              },
            },
            {
              // Raw data: Excel top rows first (import row ascending).
              $sort: {
                _row: 1 as const,
                _created: 1 as const,
                'lead._id': 1 as const,
              },
            },
          ]),
      { $skip: skip },
      { $limit: limit },
      { $project: { leadId: '$lead._id', assignedAt: 1, agentId: 1 } },
    ],
  };
  if (includeCounts) {
    facetBranches.remaining = [{ $match: rawTabMatch() }, { $count: 'n' }];
    facetBranches.called = [{ $match: calledTabMatch() }, { $count: 'n' }];
  }

  const pipeline = [
    { $match: assignmentMatch },
    {
      $lookup: {
        from: 'leads',
        localField: 'leadId',
        foreignField: '_id',
        pipeline: [{ $project: LEAD_LITE_PROJECT }],
        as: 'lead',
      },
    },
    { $unwind: '$lead' },
    ...(extraFilters.length ? [{ $match: { $and: extraFilters } }] : []),
    { $facet: facetBranches },
  ];

  const aggRows = await LeadAssignment.aggregate(pipeline as PipelineStage[]).allowDiskUse(true);
  const facet = aggRows[0] ?? { total: [], pageKeys: [], remaining: [], called: [] };
  const total = facet.total?.[0]?.n ?? 0;
  const pageKeys = (facet.pageKeys ?? []) as Array<{
    leadId: Types.ObjectId;
    assignedAt: Date;
    agentId: Types.ObjectId;
  }>;

  const leadIds = pageKeys.map((r) => r.leadId);
  const agentIds = [...new Set(pageKeys.map((r) => String(r.agentId)))].map(
    (id) => new Types.ObjectId(id)
  );

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
    meta.remaining_count = facet.remaining?.[0]?.n ?? 0;
    meta.called_count = facet.called?.[0]?.n ?? 0;
  }

  return { data, meta };
}
