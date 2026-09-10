import { PipelineStage, Types } from 'mongoose';
import { Lead, LeadAssignment, LeadFollowUp, User } from '../../models';
import { ILead } from '../../models/Lead';
import { formatLead } from '../../utils/helpers';
import { dateKeyIst, startOfIstDay } from '../../utils/istCalendar';
import { AgentLeadQuery } from './leadListFilters';

function tomorrowIst(): Date {
  return new Date(startOfIstDay().getTime() + 24 * 60 * 60 * 1000);
}

/** Never dialed (no callCount / lastCalledAt). */
function neverWorkedMatch(): Record<string, unknown> {
  return {
    $and: [
      { $or: [{ 'lead.callCount': { $exists: false } }, { 'lead.callCount': null }, { 'lead.callCount': 0 }] },
      { $or: [{ 'lead.lastCalledAt': { $exists: false } }, { 'lead.lastCalledAt': null }] },
    ],
  };
}

function workedMatch(): Record<string, unknown> {
  return {
    $or: [{ 'lead.callCount': { $gt: 0 } }, { 'lead.lastCalledAt': { $ne: null } }],
  };
}

/**
 * Remaining tab: never worked OR lead has a follow-up overdue/due today.
 * Inclusion is by lead ID from LeadFollowUp — not only Lead.nextFollowupDate
 * (legacy denormalized field is often missing/stale).
 */
function remainingTabMatch(dueFollowUpLeadIds: Types.ObjectId[]): Record<string, unknown> {
  if (dueFollowUpLeadIds.length === 0) {
    return neverWorkedMatch();
  }
  return {
    $or: [neverWorkedMatch(), { 'lead._id': { $in: dueFollowUpLeadIds } }],
  };
}

function calledTabMatch(): Record<string, unknown> {
  return workedMatch();
}

function buildLeadFieldFilters(query: AgentLeadQuery): Record<string, unknown> {
  const match: Record<string, unknown> = {};
  if (query.lead_status) match['lead.leadStatus'] = query.lead_status;
  if (query.lead_stage) match['lead.leadStage'] = query.lead_stage;
  if (query.priority) match['lead.priority'] = query.priority;
  if (query.customer_type) match['lead.customerType'] = query.customer_type;
  if (query.product) match['lead.product'] = query.product;
  if (query.state) match['lead.state'] = query.state;
  if (query.district) match['lead.district'] = query.district;
  if (query.city) match['lead.city'] = query.city;
  return match;
}

function buildSearchMatch(search?: string): Record<string, unknown> | null {
  if (!search?.trim()) return null;
  const term = search.trim();
  const rx = { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  return {
    $or: [
      { 'lead.name': rx },
      { 'lead.phoneNumber': rx },
      { 'lead.companyName': rx },
      { 'lead.company': rx },
      { 'lead.contactPerson': rx },
      { 'lead.contactMobile': rx },
      { 'lead.state': rx },
      { 'lead.district': rx },
      { 'lead.city': rx },
      { 'lead.leadCode': rx },
    ],
  };
}

/** Fields needed for tab/filter/sort/search — keep pipeline docs small. */
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
  status: 1,
  callCount: 1,
  lastCalledAt: 1,
  nextFollowupDate: 1,
  importBatchId: 1,
  importRowNumber: 1,
  createdAt: 1,
};

function remainingSortStages(overdueIdStrs: string[], dueTodayIdStrs: string[]) {
  return [
    {
      $addFields: {
        _fuRank: {
          $switch: {
            branches: [
              {
                case: { $in: [{ $toString: '$lead._id' }, overdueIdStrs] },
                then: 0,
              },
              {
                case: { $in: [{ $toString: '$lead._id' }, dueTodayIdStrs] },
                then: 1,
              },
            ],
            default: 2,
          },
        },
        _row: { $ifNull: ['$lead.importRowNumber', 999999999] },
        _created: { $ifNull: ['$lead.createdAt', '$assignedAt'] },
      },
    },
    {
      $sort: {
        // Overdue / due-today follow-ups first, then Excel row order for raw leads.
        _fuRank: 1 as const,
        'lead.nextFollowupDate': 1 as const,
        _row: 1 as const,
        _created: 1 as const,
        'lead._id': 1 as const,
      },
    },
  ];
}

function calledSortStages() {
  return [
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
  ];
}

function baseLiteLookupPipeline(agentObjectId: Types.ObjectId) {
  return [
    { $match: { agentId: agentObjectId, isActive: true } },
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
  ];
}

type DueFollowUp = { leadId: Types.ObjectId; nextFollowupDate: Date; overdue: boolean };

/**
 * Overdue / due-today follow-ups for this agent (IST calendar day),
 * matching the Flutter Follow-ups "Today" / "Overdue" sections.
 */
async function loadDueFollowUpsForAgent(agentObjectId: Types.ObjectId): Promise<DueFollowUp[]> {
  const todayKey = dateKeyIst(new Date());
  // Wide upper bound so borderline UTC/IST midnights are not dropped early.
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
  /** When false (load-more), skip badge counts — client already has them. */
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

  const dueFollowUps = await loadDueFollowUpsForAgent(agentObjectId);
  const dueFollowUpLeadIds = dueFollowUps.map((d) => d.leadId);
  const overdueIdStrs = dueFollowUps.filter((d) => d.overdue).map((d) => String(d.leadId));
  const dueTodayIdStrs = dueFollowUps.filter((d) => !d.overdue).map((d) => String(d.leadId));

  // Keep Lead.nextFollowupDate in sync for chips / older clients.
  if (dueFollowUps.length > 0) {
    await Lead.bulkWrite(
      dueFollowUps.map((d) => ({
        updateOne: {
          filter: { _id: d.leadId },
          update: { $set: { nextFollowupDate: d.nextFollowupDate } },
        },
      })),
      { ordered: false }
    );
  }

  const fieldFilters = buildLeadFieldFilters(query);
  const searchMatch = buildSearchMatch(query.search);
  const extraFilters: Record<string, unknown>[] = [];
  if (Object.keys(fieldFilters).length) extraFilters.push(fieldFilters);
  if (searchMatch) extraFilters.push(searchMatch);
  if (legacyStatus) extraFilters.push({ 'lead.status': legacyStatus });

  const tab = query.tab === 'called' ? 'called' : 'remaining';
  const tabMatch = tab === 'called' ? calledTabMatch() : remainingTabMatch(dueFollowUpLeadIds);
  const sortStages =
    tab === 'called' ? calledSortStages() : remainingSortStages(overdueIdStrs, dueTodayIdStrs);

  const facetBranches: Record<string, object[]> = {
    total: [{ $match: tabMatch }, { $count: 'n' }],
    pageKeys: [
      { $match: tabMatch },
      ...sortStages,
      { $skip: skip },
      { $limit: limit },
      { $project: { leadId: '$lead._id', assignedAt: 1 } },
    ],
  };

  if (includeCounts) {
    facetBranches.remaining = [
      { $match: remainingTabMatch(dueFollowUpLeadIds) },
      { $count: 'n' },
    ];
    facetBranches.called = [{ $match: calledTabMatch() }, { $count: 'n' }];
  }

  const pipeline = [
    ...baseLiteLookupPipeline(agentObjectId),
    ...(extraFilters.length ? [{ $match: { $and: extraFilters } }] : []),
    { $facet: facetBranches },
  ];

  const [agent, aggRows] = await Promise.all([
    User.findById(userId).select('name email teamName').lean(),
    LeadAssignment.aggregate(pipeline as PipelineStage[]).allowDiskUse(true),
  ]);

  const facet = aggRows[0] ?? { total: [], pageKeys: [], remaining: [], called: [] };
  const total = facet.total?.[0]?.n ?? 0;
  const pageKeys = (facet.pageKeys ?? []) as Array<{ leadId: Types.ObjectId; assignedAt: Date }>;

  const leadIds = pageKeys.map((r) => r.leadId);
  const leadDocs =
    leadIds.length === 0
      ? []
      : await Lead.find({ _id: { $in: leadIds } }).lean<ILead[]>();

  const byId = new Map(leadDocs.map((l) => [String(l._id), l]));
  const dueDateByLead = new Map(dueFollowUps.map((d) => [String(d.leadId), d.nextFollowupDate]));
  const data = pageKeys
    .map((row) => {
      const lead = byId.get(String(row.leadId));
      if (!lead) return null;
      const synced = dueDateByLead.get(String(row.leadId));
      if (synced) lead.nextFollowupDate = synced;
      return formatLead(lead as ILead, row.assignedAt, agent as never);
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  const meta: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
    remaining_count?: number;
    called_count?: number;
  } = {
    page,
    limit,
    total,
    total_pages: Math.max(1, Math.ceil(total / Math.max(1, limit))),
  };

  if (includeCounts) {
    meta.remaining_count = facet.remaining?.[0]?.n ?? 0;
    meta.called_count = facet.called?.[0]?.n ?? 0;
  }

  return { data, meta };
}

/** Distinct filter values without loading every lead into Node. */
export async function queryAgentFilterOptions(userId: string) {
  const agentObjectId = new Types.ObjectId(userId);
  const rows = await LeadAssignment.aggregate([
    ...(baseLiteLookupPipeline(agentObjectId) as PipelineStage[]),
    {
      $group: {
        _id: null,
        states: { $addToSet: '$lead.state' },
        districts: { $addToSet: '$lead.district' },
        cities: { $addToSet: '$lead.city' },
        lead_statuses: { $addToSet: { $ifNull: ['$lead.leadStatus', 'Open'] } },
        lead_stages: { $addToSet: '$lead.leadStage' },
        priorities: { $addToSet: '$lead.priority' },
        customer_types: { $addToSet: '$lead.customerType' },
        products: { $addToSet: '$lead.product' },
      },
    },
  ] as PipelineStage[]).allowDiskUse(true);

  const uniq = (values: unknown[]) =>
    [...new Set(values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0))].sort();

  const g = rows[0] ?? {};
  return {
    states: uniq(g.states ?? []),
    districts: uniq(g.districts ?? []),
    cities: uniq(g.cities ?? []),
    lead_statuses: uniq(g.lead_statuses ?? []),
    lead_stages: uniq(g.lead_stages ?? []),
    priorities: uniq(g.priorities ?? []),
    customer_types: uniq(g.customer_types ?? []),
    products: uniq(g.products ?? []),
  };
}
