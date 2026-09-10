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
 * Match Flutter Follow-ups "Today/Overdue": IST calendar day of nextFollowupDate
 * is on or before today's IST calendar day.
 */
function dueOnOrBeforeTodayExpr(todayKey: string): Record<string, unknown> {
  return {
    $lte: [
      {
        $dateToString: {
          format: '%Y-%m-%d',
          date: '$nextFollowupDate',
          timezone: 'Asia/Kolkata',
        },
      },
      todayKey,
    ],
  };
}

function leadDueOnOrBeforeTodayExpr(todayKey: string): Record<string, unknown> {
  return {
    $and: [
      { $ne: ['$lead.nextFollowupDate', null] },
      {
        $lte: [
          {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$lead.nextFollowupDate',
              timezone: 'Asia/Kolkata',
            },
          },
          todayKey,
        ],
      },
    ],
  };
}

/** Remaining tab: never worked OR next follow-up overdue/due today (IST). */
function remainingTabMatch(
  todayKey: string,
  dueFollowUpLeadIds: Types.ObjectId[]
): Record<string, unknown> {
  const dueClauses: Record<string, unknown>[] = [{ $expr: leadDueOnOrBeforeTodayExpr(todayKey) }];
  if (dueFollowUpLeadIds.length > 0) {
    dueClauses.push({ 'lead._id': { $in: dueFollowUpLeadIds } });
  }
  return {
    $or: [neverWorkedMatch(), ...dueClauses],
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

function remainingSortStages(todayKey: string) {
  const todayStart = startOfIstDay();
  const tomorrowStart = tomorrowIst();
  const followUpCollection = LeadFollowUp.collection.collectionName;
  return [
    {
      $lookup: {
        from: followUpCollection,
        let: { lid: '$lead._id' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [{ $eq: ['$leadId', '$$lid'] }, { $ne: ['$nextFollowupDate', null] }, dueOnOrBeforeTodayExpr(todayKey)],
              },
            },
          },
          { $sort: { nextFollowupDate: 1 as const } },
          { $limit: 1 },
          { $project: { nextFollowupDate: 1 } },
        ],
        as: '_dueFu',
      },
    },
    {
      $addFields: {
        _dueDate: {
          $ifNull: [{ $arrayElemAt: ['$_dueFu.nextFollowupDate', 0] }, '$lead.nextFollowupDate'],
        },
      },
    },
    {
      $addFields: {
        _fuRank: {
          $cond: [
            {
              $and: [{ $ne: ['$_dueDate', null] }, { $lt: ['$_dueDate', todayStart] }],
            },
            0,
            {
              $cond: [
                {
                  $and: [{ $ne: ['$_dueDate', null] }, { $lt: ['$_dueDate', tomorrowStart] }],
                },
                1,
                2,
              ],
            },
          ],
        },
        _row: { $ifNull: ['$lead.importRowNumber', 999999999] },
        _created: { $ifNull: ['$lead.createdAt', '$assignedAt'] },
      },
    },
    {
      $sort: {
        _fuRank: 1 as const,
        _dueDate: 1 as const,
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
        // Keep matched leads tiny for filter/sort/count; full docs loaded only for the page.
        pipeline: [{ $project: LEAD_LITE_PROJECT }],
        as: 'lead',
      },
    },
    { $unwind: '$lead' },
  ];
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
  const todayKey = dateKeyIst(new Date());
  const skip = (page - 1) * limit;

  const dueFollowUpRows = await LeadFollowUp.find({
    agentId: agentObjectId,
    nextFollowupDate: { $ne: null },
    $expr: dueOnOrBeforeTodayExpr(todayKey),
  })
    .select('leadId nextFollowupDate')
    .lean();

  const dueFollowUpLeadIds = [
    ...new Map(
      dueFollowUpRows.map((r) => [String(r.leadId), r.leadId as Types.ObjectId])
    ).values(),
  ];

  // Always mirror the earliest due FollowUp date onto Lead (fixes stale/missing denormalized field).
  if (dueFollowUpRows.length > 0) {
    const earliestByLead = new Map<string, Date>();
    for (const row of dueFollowUpRows) {
      const id = String(row.leadId);
      const d = row.nextFollowupDate as Date;
      const prev = earliestByLead.get(id);
      if (!prev || d < prev) earliestByLead.set(id, d);
    }
    await Promise.all(
      [...earliestByLead.entries()].map(([id, nextFollowupDate]) =>
        Lead.updateOne({ _id: id }, { $set: { nextFollowupDate } })
      )
    );
  }

  const fieldFilters = buildLeadFieldFilters(query);
  const searchMatch = buildSearchMatch(query.search);
  const extraFilters: Record<string, unknown>[] = [];
  if (Object.keys(fieldFilters).length) extraFilters.push(fieldFilters);
  if (searchMatch) extraFilters.push(searchMatch);
  if (legacyStatus) extraFilters.push({ 'lead.status': legacyStatus });

  const tab = query.tab === 'called' ? 'called' : 'remaining';
  const tabMatch =
    tab === 'called' ? calledTabMatch() : remainingTabMatch(todayKey, dueFollowUpLeadIds);
  const sortStages = tab === 'called' ? calledSortStages() : remainingSortStages(todayKey);

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
      { $match: remainingTabMatch(todayKey, dueFollowUpLeadIds) },
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
  const data = pageKeys
    .map((row) => {
      const lead = byId.get(String(row.leadId));
      if (!lead) return null;
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
