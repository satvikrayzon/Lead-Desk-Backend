import { Types } from 'mongoose';
import { Lead, LeadAssignment, LeadFollowUp, User } from '../../models';
import { ILead } from '../../models/Lead';
import { formatLead } from '../../utils/helpers';
import { dateKeyIst, startOfIstDay } from '../../utils/istCalendar';
import { ensureAssignmentListBackfill } from '../../services/assignmentListSync';
import { AgentLeadQuery } from './leadListFilters';

function tomorrowIst(): Date {
  return new Date(startOfIstDay().getTime() + 24 * 60 * 60 * 1000);
}

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyAssignmentFilters(match: Record<string, unknown>, query: AgentLeadQuery): void {
  if (query.lead_status) match.leadStatus = query.lead_status;
  if (query.lead_stage) match.leadStage = query.lead_stage;
  if (query.priority) match.priority = query.priority;
  if (query.customer_type) match.customerType = query.customer_type;
  if (query.product) match.product = query.product;
  if (query.state) match.state = query.state;
  if (query.district) match.district = query.district;
  if (query.city) match.city = query.city;
  if (query.search?.trim()) {
    const rx = { $regex: escapeRegex(query.search.trim()), $options: 'i' };
    match.$or = [
      { companyName: rx },
      { contactPerson: rx },
      { contactMobile: rx },
      { leadCode: rx },
      { state: rx },
      { district: rx },
      { city: rx },
    ];
  }
}

/** Leads that have at least one follow-up tagged with this sales result. */
export async function leadIdsForLeadResult(
  agentObjectId: Types.ObjectId,
  leadResult: string
): Promise<Types.ObjectId[]> {
  const token = leadResult.trim().toLowerCase();
  if (!token) return [];
  const rows = await LeadFollowUp.find({
    agentId: agentObjectId,
    leadResult: { $regex: `(^|,)\\s*${escapeRegex(token)}\\s*(,|$)`, $options: 'i' },
  })
    .select('leadId')
    .lean();
  const uniq = [...new Set(rows.map((r) => String(r.leadId)).filter(Boolean))];
  return uniq.map((id) => new Types.ObjectId(id));
}

type DueFollowUp = { leadId: Types.ObjectId; nextFollowupDate: Date; overdue: boolean };

async function loadDueFollowUpsForAgent(agentObjectId: Types.ObjectId): Promise<DueFollowUp[]> {
  const todayKey = dateKeyIst(new Date());
  const dayAfterTomorrow = new Date(tomorrowIst().getTime() + 24 * 60 * 60 * 1000);

  const rows = await LeadFollowUp.find({
    agentId: agentObjectId,
    nextFollowupDate: { $exists: true, $ne: null, $lt: dayAfterTomorrow },
  })
    .select('leadId nextFollowupDate')
    .lean();

  const earliest = new Map<string, { date: Date; overdue: boolean }>();

  for (const row of rows) {
    if (!row.nextFollowupDate || !row.leadId) continue;
    const d = row.nextFollowupDate as Date;
    const key = dateKeyIst(d);
    if (key > todayKey) continue;

    const id = String(row.leadId);
    const overdue = key < todayKey;
    const prev = earliest.get(id);
    if (!prev || d < prev.date) {
      earliest.set(id, { date: d, overdue });
    }
  }

  return [...earliest.entries()].map(([id, v]) => ({
    leadId: new Types.ObjectId(id),
    nextFollowupDate: v.date,
    overdue: v.overdue,
  }));
}

export async function queryAgentLeadsPage(input: {
  userId: string;
  page: number;
  limit: number;
  query: AgentLeadQuery;
  legacyStatus?: string;
  includeCounts?: boolean;
}): Promise<{
  data: ReturnType<typeof formatLead>[];
  meta: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
    remaining_count?: number;
    called_count?: number;
  };
}> {
  const { userId, page, limit, query } = input;
  const includeCounts = input.includeCounts !== false;
  const agentObjectId = new Types.ObjectId(userId);
  const skip = (page - 1) * limit;
  const tab = query.tab === 'called' ? 'called' : 'remaining';

  await ensureAssignmentListBackfill();

  const [dueFollowUps, agent] = await Promise.all([
    loadDueFollowUpsForAgent(agentObjectId),
    User.findById(userId).select('name email teamName').lean(),
  ]);

  const dueIds = dueFollowUps.map((d) => d.leadId);
  const dueDateByLead = new Map(dueFollowUps.map((d) => [String(d.leadId), d.nextFollowupDate]));
  const overdueIdSet = new Set(dueFollowUps.filter((d) => d.overdue).map((d) => String(d.leadId)));
  const dueTodayIdSet = new Set(dueFollowUps.filter((d) => !d.overdue).map((d) => String(d.leadId)));

  const base: Record<string, unknown> = { isActive: true, agentId: agentObjectId };
  applyAssignmentFilters(base, query);

  if (query.lead_result) {
    const resultLeadIds = await leadIdsForLeadResult(agentObjectId, query.lead_result);
    if (resultLeadIds.length === 0) {
      return {
        data: [],
        meta: {
          page,
          limit,
          total: 0,
          total_pages: 1,
          remaining_count: includeCounts ? 0 : undefined,
          called_count: includeCounts ? 0 : undefined,
        },
      };
    }
    base.leadId = { $in: resultLeadIds };
  }

  const remainingClause: Record<string, unknown> =
    dueIds.length === 0
      ? { callCount: { $lte: 0 } }
      : { $or: [{ callCount: { $lte: 0 } }, { leadId: { $in: dueIds } }] };
  const remainingMatch = { $and: [base, remainingClause] };
  const calledMatch = { $and: [base, { callCount: { $gt: 0 } }] };
  const tabMatch = tab === 'called' ? calledMatch : remainingMatch;

  const [pageRows, total, remainingCount, calledCount] = await Promise.all([
    tab === 'called'
      ? LeadAssignment.find(tabMatch)
          .select('leadId agentId assignedAt')
          .sort({ lastCalledAt: -1, _id: -1 })
          .skip(skip)
          .limit(limit)
          .lean()
      : LeadAssignment.aggregate<{ leadId: Types.ObjectId; agentId: Types.ObjectId; assignedAt: Date }>([
          { $match: tabMatch },
          {
            $addFields: {
              _fuRank: {
                $switch: {
                  branches: [
                    { case: { $in: ['$leadId', [...overdueIdSet].map((id) => new Types.ObjectId(id))] }, then: 0 },
                    { case: { $in: ['$leadId', [...dueTodayIdSet].map((id) => new Types.ObjectId(id))] }, then: 1 },
                  ],
                  default: 2,
                },
              },
              _row: { $ifNull: ['$importRowNumber', 999999999] },
            },
          },
          { $sort: { _fuRank: 1, nextFollowupDate: 1, _row: 1, assignedAt: 1, _id: 1 } },
          { $skip: skip },
          { $limit: limit },
          { $project: { leadId: 1, agentId: 1, assignedAt: 1 } },
        ]),
    LeadAssignment.countDocuments(tabMatch),
    includeCounts ? LeadAssignment.countDocuments(remainingMatch) : Promise.resolve(0),
    includeCounts ? LeadAssignment.countDocuments(calledMatch) : Promise.resolve(0),
  ]);

  const leadIds = pageRows.map((r) => r.leadId);
  const leadDocs =
    leadIds.length === 0 ? ([] as ILead[]) : await Lead.find({ _id: { $in: leadIds } }).lean<ILead[]>();
  const leadById = new Map(leadDocs.map((l) => [String(l._id), l]));
  const assignByLead = new Map(pageRows.map((r) => [String(r.leadId), r]));

  const data = leadIds
    .map((id) => {
      const lead = leadById.get(String(id));
      const row = assignByLead.get(String(id));
      if (!lead || !row) return null;
      const synced = dueDateByLead.get(String(id));
      if (synced) lead.nextFollowupDate = synced;
      return formatLead(lead as ILead, row.assignedAt, agent as never);
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  return {
    data,
    meta: {
      page,
      limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / Math.max(1, limit))),
      remaining_count: includeCounts ? remainingCount : undefined,
      called_count: includeCounts ? calledCount : undefined,
    },
  };
}

export async function queryAgentFilterOptions(userId: string) {
  await ensureAssignmentListBackfill();
  const rows = await LeadAssignment.aggregate<{
    states: string[];
    districts: string[];
    cities: string[];
    lead_statuses: string[];
    lead_stages: string[];
    priorities: string[];
    customer_types: string[];
    products: string[];
  }>([
    { $match: { isActive: true, agentId: new Types.ObjectId(userId) } },
    {
      $group: {
        _id: null,
        states: { $addToSet: '$state' },
        districts: { $addToSet: '$district' },
        cities: { $addToSet: '$city' },
        lead_statuses: { $addToSet: { $ifNull: ['$leadStatus', 'Open'] } },
        lead_stages: { $addToSet: '$leadStage' },
        priorities: { $addToSet: '$priority' },
        customer_types: { $addToSet: '$customerType' },
        products: { $addToSet: '$product' },
      },
    },
  ]);

  const uniq = (values: unknown[]) =>
    [...new Set(values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0))].sort();

  const g = rows[0] ?? {
    states: [],
    districts: [],
    cities: [],
    lead_statuses: [],
    lead_stages: [],
    priorities: [],
    customer_types: [],
    products: [],
  };

  return {
    states: uniq(g.states),
    districts: uniq(g.districts),
    cities: uniq(g.cities),
    lead_statuses: uniq(g.lead_statuses),
    lead_stages: uniq(g.lead_stages),
    priorities: uniq(g.priorities),
    customer_types: uniq(g.customer_types),
    products: uniq(g.products),
  };
}
