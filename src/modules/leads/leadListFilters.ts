import { ILead } from '../../models/Lead';

export interface AgentLeadQuery {
  search?: string;
  tab?: string;
  lead_status?: string;
  lead_stage?: string;
  priority?: string;
  customer_type?: string;
  product?: string;
  state?: string;
  district?: string;
  city?: string;
}

type PopulatedAssignment = { leadId: ILead; assignedAt: Date };

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function dayOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Overdue or due today — must be dialed before fresh remaining leads. */
function hasCompulsoryFollowUp(nextFollowupDate: Date | string | null | undefined): boolean {
  if (!nextFollowupDate) return false;
  const raw = nextFollowupDate instanceof Date ? nextFollowupDate : new Date(nextFollowupDate);
  if (Number.isNaN(raw.getTime())) return false;
  const day = dayOnly(raw);
  const today = dayOnly(new Date());
  return day.getTime() <= today.getTime();
}

function followUpRank(lead: ILead): number {
  if (!lead.nextFollowupDate) return 2;
  const day = dayOnly(new Date(lead.nextFollowupDate));
  const today = dayOnly(new Date());
  if (day.getTime() < today.getTime()) return 0; // overdue
  if (day.getTime() === today.getTime()) return 1; // today
  return 2;
}

function newestTimestamp(a: PopulatedAssignment): number {
  const assigned = a.assignedAt instanceof Date ? a.assignedAt.getTime() : 0;
  const createdRaw = a.leadId.createdAt;
  const created =
    createdRaw instanceof Date
      ? createdRaw.getTime()
      : createdRaw
        ? new Date(createdRaw).getTime()
        : 0;
  return Math.max(assigned || 0, created || 0);
}

/** Mongo ObjectId creation time — preserves bulk insert / Excel row order. */
function leadInsertOrder(lead: ILead): number {
  try {
    const id = lead._id as { getTimestamp?: () => Date; toString?: () => string };
    if (typeof id?.getTimestamp === 'function') {
      return id.getTimestamp().getTime();
    }
    const hex = typeof id?.toString === 'function' ? id.toString() : String(lead._id);
    if (/^[a-f0-9]{24}$/i.test(hex)) {
      return parseInt(hex.slice(0, 8), 16) * 1000;
    }
  } catch {
    // ignore
  }
  return 0;
}

/**
 * Remaining list order (backend is source of truth for app list order):
 * 1) Overdue / due-today follow-ups first
 * 2) Newer import batches before older ones
 * 3) Within a batch — Excel sheet order (1st row at top)
 */
function compareRemainingAssignments(a: PopulatedAssignment, b: PopulatedAssignment): number {
  const ra = followUpRank(a.leadId);
  const rb = followUpRank(b.leadId);
  if (ra !== rb) return ra - rb;
  if ((ra === 0 || ra === 1) && a.leadId.nextFollowupDate && b.leadId.nextFollowupDate) {
    const da = new Date(a.leadId.nextFollowupDate).getTime();
    const db = new Date(b.leadId.nextFollowupDate).getTime();
    if (da !== db) return da - db;
  }

  const batchA = a.leadId.importBatchId?.toString() ?? '';
  const batchB = b.leadId.importBatchId?.toString() ?? '';
  if (batchA && batchB && batchA !== batchB) {
    const ta = newestTimestamp(a);
    const tb = newestTimestamp(b);
    if (ta !== tb) return tb - ta; // newer import batch first
  }

  const rowA = a.leadId.importRowNumber;
  const rowB = b.leadId.importRowNumber;
  if (rowA != null && rowB != null && rowA !== rowB) return rowA - rowB;
  if (rowA != null && rowB == null) return -1;
  if (rowA == null && rowB != null) return 1;

  // Already-imported sheets (no importRowNumber): ObjectId / created order ≈ Excel order
  const ia = leadInsertOrder(a.leadId);
  const ib = leadInsertOrder(b.leadId);
  if (ia !== ib) return ia - ib;
  return newestTimestamp(a) - newestTimestamp(b);
}

/** Called tab: most recently assigned/created first. */
function compareCalledAssignments(a: PopulatedAssignment, b: PopulatedAssignment): number {
  return newestTimestamp(b) - newestTimestamp(a);
}

export function parseAgentLeadQuery(query: Record<string, unknown>): AgentLeadQuery {
  return {
    search: asString(query.search),
    tab: asString(query.tab),
    lead_status: asString(query.lead_status),
    lead_stage: asString(query.lead_stage),
    priority: asString(query.priority),
    customer_type: asString(query.customer_type),
    product: asString(query.product),
    state: asString(query.state),
    district: asString(query.district),
    city: asString(query.city),
  };
}

export function filterAgentLeadAssignments(
  assignments: PopulatedAssignment[],
  query: AgentLeadQuery
): PopulatedAssignment[] {
  let filtered = assignments.filter((a) => a.leadId);

  if (query.lead_status) {
    filtered = filtered.filter((a) => (a.leadId.leadStatus ?? 'Open') === query.lead_status);
  }
  if (query.lead_stage) {
    filtered = filtered.filter((a) => a.leadId.leadStage === query.lead_stage);
  }
  if (query.priority) {
    filtered = filtered.filter((a) => a.leadId.priority === query.priority);
  }
  if (query.customer_type) {
    filtered = filtered.filter((a) => a.leadId.customerType === query.customer_type);
  }
  if (query.product) {
    filtered = filtered.filter((a) => a.leadId.product === query.product);
  }
  if (query.state) {
    filtered = filtered.filter((a) => a.leadId.state === query.state);
  }
  if (query.district) {
    filtered = filtered.filter((a) => a.leadId.district === query.district);
  }
  if (query.city) {
    filtered = filtered.filter((a) => a.leadId.city === query.city);
  }

  if (query.tab === 'called') {
    filtered = filtered.filter((a) => {
      const lead = a.leadId;
      const called = (lead.callCount ?? 0) > 0;
      return called && !hasCompulsoryFollowUp(lead.nextFollowupDate);
    });
  } else if (query.tab === 'remaining') {
    filtered = filtered.filter((a) => {
      const lead = a.leadId;
      const neverCalled = (lead.callCount ?? 0) === 0;
      return neverCalled || hasCompulsoryFollowUp(lead.nextFollowupDate);
    });
  }

  if (query.search) {
    const term = query.search.toLowerCase();
    filtered = filtered.filter((a) => {
      const lead = a.leadId;
      return (
        lead.name.toLowerCase().includes(term) ||
        lead.phoneNumber.includes(query.search!) ||
        (lead.companyName ?? '').toLowerCase().includes(term) ||
        (lead.company ?? '').toLowerCase().includes(term) ||
        (lead.contactPerson ?? '').toLowerCase().includes(term) ||
        (lead.contactMobile ?? '').includes(query.search!) ||
        (lead.state ?? '').toLowerCase().includes(term) ||
        (lead.district ?? '').toLowerCase().includes(term) ||
        (lead.city ?? '').toLowerCase().includes(term)
      );
    });
  }

  if (query.tab === 'remaining') {
    filtered.sort(compareRemainingAssignments);
  } else {
    filtered.sort(compareCalledAssignments);
  }

  return filtered;
}

export function isRemainingAssignment(lead: ILead): boolean {
  const neverCalled = (lead.callCount ?? 0) === 0;
  return neverCalled || hasCompulsoryFollowUp(lead.nextFollowupDate);
}

export function isCalledAssignment(lead: ILead): boolean {
  return (lead.callCount ?? 0) > 0 && !hasCompulsoryFollowUp(lead.nextFollowupDate);
}

export function countAgentTabTotals(
  assignments: PopulatedAssignment[],
  query: Omit<AgentLeadQuery, 'tab'>
): { remaining: number; called: number } {
  const base = filterAgentLeadAssignments(assignments, { ...query, tab: undefined });
  let remaining = 0;
  let called = 0;
  for (const a of base) {
    if (isRemainingAssignment(a.leadId)) remaining += 1;
    else if (isCalledAssignment(a.leadId)) called += 1;
  }
  return { remaining, called };
}

export function extractAgentFilterOptions(leads: ILead[]) {
  const uniq = (values: (string | undefined | null)[]) =>
    [...new Set(values.filter((v): v is string => !!v && v.trim().length > 0))].sort();

  return {
    states: uniq(leads.map((l) => l.state)),
    districts: uniq(leads.map((l) => l.district)),
    cities: uniq(leads.map((l) => l.city)),
    lead_statuses: uniq(leads.map((l) => l.leadStatus ?? 'Open')),
    lead_stages: uniq(leads.map((l) => l.leadStage)),
    priorities: uniq(leads.map((l) => l.priority)),
    customer_types: uniq(leads.map((l) => l.customerType)),
    products: uniq(leads.map((l) => l.product)),
  };
}
