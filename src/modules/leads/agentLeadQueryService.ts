import { Types } from 'mongoose';
import { Lead, LeadFollowUp, User } from '../../models';
import { ILead } from '../../models/Lead';
import { formatLead } from '../../utils/helpers';
import { dateKeyIst, startOfIstDay } from '../../utils/istCalendar';
import { leadMatchesSearch, loadAssignmentLeadRows } from '../../services/assignmentLeadLite';
import { AgentLeadQuery } from './leadListFilters';

function tomorrowIst(): Date {
  return new Date(startOfIstDay().getTime() + 24 * 60 * 60 * 1000);
}

function neverWorked(lead: ILead): boolean {
  return !(lead.callCount && lead.callCount > 0) && !lead.lastCalledAt;
}

function worked(lead: ILead): boolean {
  return (lead.callCount ?? 0) > 0 || Boolean(lead.lastCalledAt);
}

function matchesFieldFilters(lead: ILead, query: AgentLeadQuery, legacyStatus?: string): boolean {
  if (query.lead_status && (lead.leadStatus ?? '') !== query.lead_status) return false;
  if (query.lead_stage && (lead.leadStage ?? '') !== query.lead_stage) return false;
  if (query.priority && (lead.priority ?? '') !== query.priority) return false;
  if (query.customer_type && (lead.customerType ?? '') !== query.customer_type) return false;
  if (query.product && (lead.product ?? '') !== query.product) return false;
  if (query.state && (lead.state ?? '') !== query.state) return false;
  if (query.district && (lead.district ?? '') !== query.district) return false;
  if (query.city && (lead.city ?? '') !== query.city) return false;
  if (legacyStatus && (lead.status ?? '') !== legacyStatus) return false;
  return true;
}

type DueFollowUp = { leadId: Types.ObjectId; nextFollowupDate: Date; overdue: boolean };

/**
 * Overdue / due-today follow-ups for this agent (IST calendar day),
 * matching the Flutter Follow-ups "Today" / "Overdue" sections.
 */
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
  const { userId, page, limit, query, legacyStatus } = input;
  const includeCounts = input.includeCounts !== false;
  const agentObjectId = new Types.ObjectId(userId);
  const skip = (page - 1) * limit;
  const tab = query.tab === 'called' ? 'called' : 'remaining';

  const [dueFollowUps, rows, agent] = await Promise.all([
    loadDueFollowUpsForAgent(agentObjectId),
    loadAssignmentLeadRows({ agentId: agentObjectId, isActive: true }),
    User.findById(userId).select('name email teamName').lean(),
  ]);

  const dueIdSet = new Set(dueFollowUps.map((d) => String(d.leadId)));
  const overdueIdSet = new Set(dueFollowUps.filter((d) => d.overdue).map((d) => String(d.leadId)));
  const dueTodayIdSet = new Set(dueFollowUps.filter((d) => !d.overdue).map((d) => String(d.leadId)));
  const dueDateByLead = new Map(dueFollowUps.map((d) => [String(d.leadId), d.nextFollowupDate]));

  const filtered = rows.filter((row) => {
    if (!matchesFieldFilters(row.lead, query, legacyStatus)) return false;
    if (!leadMatchesSearch(row.lead, query.search)) return false;
    return true;
  });

  const remainingRows = filtered.filter((row) => neverWorked(row.lead) || dueIdSet.has(String(row.leadId)));
  const calledRows = filtered.filter((row) => worked(row.lead));
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
    const rank = (id: string) => (overdueIdSet.has(id) ? 0 : dueTodayIdSet.has(id) ? 1 : 2);
    sorted.sort((a, b) => {
      const ida = String(a.leadId);
      const idb = String(b.leadId);
      const ra = rank(ida);
      const rb = rank(idb);
      if (ra !== rb) return ra - rb;
      const da = a.lead.nextFollowupDate?.getTime() ?? Number.POSITIVE_INFINITY;
      const db = b.lead.nextFollowupDate?.getTime() ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      const rowa = a.lead.importRowNumber ?? 999999999;
      const rowb = b.lead.importRowNumber ?? 999999999;
      if (rowa !== rowb) return rowa - rowb;
      const ca = (a.lead.createdAt ?? a.assignedAt).getTime();
      const cb = (b.lead.createdAt ?? b.assignedAt).getTime();
      if (ca !== cb) return ca - cb;
      return ida.localeCompare(idb);
    });
  }

  const total = sorted.length;
  const pageKeys = sorted.slice(skip, skip + limit);
  const leadIds = pageKeys.map((r) => r.leadId);
  const leadDocs =
    leadIds.length === 0 ? [] : await Lead.find({ _id: { $in: leadIds } }).lean<ILead[]>();
  const byId = new Map(leadDocs.map((l) => [String(l._id), l]));

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
    meta.remaining_count = remainingRows.length;
    meta.called_count = calledRows.length;
  }

  return { data, meta };
}

export async function queryAgentFilterOptions(userId: string) {
  const rows = await loadAssignmentLeadRows({
    agentId: new Types.ObjectId(userId),
    isActive: true,
  });

  const uniq = (values: unknown[]) =>
    [...new Set(values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0))].sort();

  return {
    states: uniq(rows.map((r) => r.lead.state)),
    districts: uniq(rows.map((r) => r.lead.district)),
    cities: uniq(rows.map((r) => r.lead.city)),
    lead_statuses: uniq(rows.map((r) => r.lead.leadStatus ?? 'Open')),
    lead_stages: uniq(rows.map((r) => r.lead.leadStage)),
    priorities: uniq(rows.map((r) => r.lead.priority)),
    customer_types: uniq(rows.map((r) => r.lead.customerType)),
    products: uniq(rows.map((r) => r.lead.product)),
  };
}
