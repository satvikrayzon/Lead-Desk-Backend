import { FilterQuery, Types } from 'mongoose';
import { Lead, LeadFollowUp, User } from '../../models';
import { ILead } from '../../models/Lead';
import { formatLead } from '../../utils/helpers';
import { dateKeyIst, startOfIstDay } from '../../utils/istCalendar';
import { calledTabMongo, loadAssignmentIndex, neverWorkedMongo } from '../../services/assignmentLeadLite';
import { AgentLeadQuery } from './leadListFilters';

function tomorrowIst(): Date {
  return new Date(startOfIstDay().getTime() + 24 * 60 * 60 * 1000);
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

function applyLeadFieldFilters(match: FilterQuery<ILead>, query: AgentLeadQuery, legacyStatus?: string) {
  if (query.lead_status) match.leadStatus = query.lead_status;
  if (query.lead_stage) match.leadStage = query.lead_stage;
  if (query.priority) match.priority = query.priority;
  if (query.customer_type) match.customerType = query.customer_type;
  if (query.product) match.product = query.product;
  if (query.state) match.state = query.state;
  if (query.district) match.district = query.district;
  if (query.city) match.city = query.city;
  if (legacyStatus) match.status = legacyStatus;
}

function searchMongo(search?: string): FilterQuery<ILead> | null {
  if (!search?.trim()) return null;
  const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = { $regex: term, $options: 'i' };
  return {
    $or: [
      { name: rx },
      { phoneNumber: rx },
      { companyName: rx },
      { company: rx },
      { contactPerson: rx },
      { contactMobile: rx },
      { state: rx },
      { district: rx },
      { city: rx },
      { leadCode: rx },
    ],
  };
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
  const { userId, page, limit, query, legacyStatus } = input;
  const includeCounts = input.includeCounts !== false;
  const agentObjectId = new Types.ObjectId(userId);
  const skip = (page - 1) * limit;
  const tab = query.tab === 'called' ? 'called' : 'remaining';

  const [dueFollowUps, assignments, agent] = await Promise.all([
    loadDueFollowUpsForAgent(agentObjectId),
    loadAssignmentIndex({ agentId: agentObjectId, isActive: true }),
    User.findById(userId).select('name email teamName').lean(),
  ]);

  if (assignments.length === 0) {
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

  const assignByLead = new Map(assignments.map((a) => [String(a.leadId), a]));
  const leadIds = assignments.map((a) => a.leadId);
  const dueIds = dueFollowUps.map((d) => d.leadId);
  const dueDateByLead = new Map(dueFollowUps.map((d) => [String(d.leadId), d.nextFollowupDate]));
  const overdueIds = dueFollowUps.filter((d) => d.overdue).map((d) => d.leadId);
  const dueTodayIds = dueFollowUps.filter((d) => !d.overdue).map((d) => d.leadId);

  const base: FilterQuery<ILead> = { _id: { $in: leadIds } };
  applyLeadFieldFilters(base, query, legacyStatus);
  const search = searchMongo(query.search);
  const extras: FilterQuery<ILead>[] = [];
  if (search) extras.push(search);

  const remainingTab =
    dueIds.length === 0
      ? neverWorkedMongo()
      : { $or: [neverWorkedMongo(), { _id: { $in: dueIds } }] };

  const withExtras = (tabMatch: FilterQuery<ILead>): FilterQuery<ILead> => {
    const parts = [base, tabMatch, ...extras];
    return { $and: parts };
  };

  const remainingMatch = withExtras(remainingTab);
  const calledMatch = withExtras({
    $or: [{ callCount: { $gt: 0 } }, { lastCalledAt: { $ne: null } }],
  });
  const tabMatch = tab === 'called' ? calledMatch : remainingMatch;

  const [total, remainingCount, calledCount, pageLeads] = await Promise.all([
    Lead.countDocuments(tabMatch),
    includeCounts ? Lead.countDocuments(remainingMatch) : Promise.resolve(0),
    includeCounts ? Lead.countDocuments(calledMatch) : Promise.resolve(0),
    tab === 'called'
      ? Lead.find(tabMatch)
          .sort({ lastCalledAt: -1, _id: -1 })
          .skip(skip)
          .limit(limit)
          .lean<ILead[]>()
      : Lead.aggregate<ILead>([
          { $match: tabMatch },
          {
            $addFields: {
              _fuRank: {
                $switch: {
                  branches: [
                    { case: { $in: ['$_id', overdueIds] }, then: 0 },
                    { case: { $in: ['$_id', dueTodayIds] }, then: 1 },
                  ],
                  default: 2,
                },
              },
              _row: { $ifNull: ['$importRowNumber', 999999999] },
            },
          },
          { $sort: { _fuRank: 1, nextFollowupDate: 1, _row: 1, createdAt: 1, _id: 1 } },
          { $skip: skip },
          { $limit: limit },
        ]),
  ]);

  const data = pageLeads
    .map((lead) => {
      const row = assignByLead.get(String(lead._id));
      if (!row) return null;
      const synced = dueDateByLead.get(String(lead._id));
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
  const assignments = await loadAssignmentIndex({
    agentId: new Types.ObjectId(userId),
    isActive: true,
  });
  const leadIds = assignments.map((a) => a.leadId);
  if (leadIds.length === 0) {
    return {
      states: [],
      districts: [],
      cities: [],
      lead_statuses: [],
      lead_stages: [],
      priorities: [],
      customer_types: [],
      products: [],
    };
  }

  const rows = await Lead.aggregate<{
    states: string[];
    districts: string[];
    cities: string[];
    lead_statuses: string[];
    lead_stages: string[];
    priorities: string[];
    customer_types: string[];
    products: string[];
  }>([
    { $match: { _id: { $in: leadIds } } },
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
