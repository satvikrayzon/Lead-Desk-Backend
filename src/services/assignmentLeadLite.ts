import { Types } from 'mongoose';
import { Lead, LeadAssignment, User } from '../models';
import { ILead } from '../models/Lead';
import { formatLead } from '../utils/helpers';

export type AssignmentIndexRow = {
  leadId: Types.ObjectId;
  agentId: Types.ObjectId;
  assignedAt: Date;
};

export type AssignmentStatRow = AssignmentIndexRow & {
  callCount?: number;
  lastCalledAt?: Date | null;
  nextFollowupDate?: Date | null;
};

export type AgentAssignmentStats = {
  assigned: number;
  called: number;
  remaining: number;
};

function neverWorked(lead: { callCount?: number; lastCalledAt?: Date | null }): boolean {
  return !(lead.callCount && lead.callCount > 0) && !lead.lastCalledAt;
}

function worked(lead: { callCount?: number; lastCalledAt?: Date | null }): boolean {
  return (lead.callCount ?? 0) > 0 || Boolean(lead.lastCalledAt);
}

export function isPendingLead(
  lead: { callCount?: number; lastCalledAt?: Date | null; nextFollowupDate?: Date | null },
  tomorrowStart: Date
): boolean {
  if (neverWorked(lead)) return true;
  const next = lead.nextFollowupDate;
  return Boolean(next && next < tomorrowStart);
}

export function isCalledLead(lead: { callCount?: number; lastCalledAt?: Date | null }): boolean {
  return worked(lead);
}

export function isRawLead(lead: { callCount?: number }): boolean {
  return !(lead.callCount && lead.callCount > 0);
}

export async function loadAssignmentIndex(match: Record<string, unknown>): Promise<AssignmentIndexRow[]> {
  const assignments = await LeadAssignment.find(match).select('leadId agentId assignedAt').lean();
  return assignments.map((a) => ({
    leadId: a.leadId as Types.ObjectId,
    agentId: a.agentId as Types.ObjectId,
    assignedAt: a.assignedAt,
  }));
}

/** Tiny per-lead counters only — never pull full lead documents for 5k+ rows. */
export async function loadAssignmentStatRows(match: Record<string, unknown>): Promise<AssignmentStatRow[]> {
  const assignments = await loadAssignmentIndex(match);
  if (assignments.length === 0) return [];

  const leads = await Lead.find({ _id: { $in: assignments.map((a) => a.leadId) } })
    .select('callCount lastCalledAt nextFollowupDate')
    .lean();
  const byId = new Map(leads.map((l) => [String(l._id), l]));

  const rows: AssignmentStatRow[] = [];
  for (const a of assignments) {
    const lead = byId.get(String(a.leadId));
    if (!lead) continue;
    rows.push({
      ...a,
      callCount: lead.callCount,
      lastCalledAt: lead.lastCalledAt,
      nextFollowupDate: lead.nextFollowupDate,
    });
  }
  return rows;
}

export async function loadAssignmentStatsByAgent(
  agentIds: Types.ObjectId[],
  tomorrowStart: Date
): Promise<Map<string, AgentAssignmentStats>> {
  const stats = new Map<string, AgentAssignmentStats>();
  for (const id of agentIds) {
    stats.set(String(id), { assigned: 0, called: 0, remaining: 0 });
  }
  if (agentIds.length === 0) return stats;

  const rows = await loadAssignmentStatRows({ isActive: true, agentId: { $in: agentIds } });
  for (const row of rows) {
    const key = String(row.agentId);
    const cur = stats.get(key) ?? { assigned: 0, called: 0, remaining: 0 };
    cur.assigned += 1;
    if (worked(row)) cur.called += 1;
    if (isPendingLead(row, tomorrowStart)) cur.remaining += 1;
    stats.set(key, cur);
  }
  return stats;
}

export async function loadPendingAssignmentKeys(
  match: Record<string, unknown>,
  tomorrowStart: Date,
  limit: number
): Promise<AssignmentIndexRow[]> {
  const rows = await loadAssignmentStatRows(match);
  return rows
    .filter((row) => isPendingLead(row, tomorrowStart))
    .sort((a, b) => b.assignedAt.getTime() - a.assignedAt.getTime())
    .slice(0, limit)
    .map(({ leadId, agentId, assignedAt }) => ({ leadId, agentId, assignedAt }));
}

export async function hydratePendingLeads(pending: AssignmentIndexRow[]) {
  if (pending.length === 0) return [];
  const leadIds = pending.map((r) => r.leadId);
  const agentIds = [...new Set(pending.map((r) => String(r.agentId)))].map((id) => new Types.ObjectId(id));
  const [leadDocs, agents] = await Promise.all([
    Lead.find({ _id: { $in: leadIds } }).lean<ILead[]>(),
    agentIds.length === 0
      ? Promise.resolve([])
      : User.find({ _id: { $in: agentIds } }).select('name email teamName').lean(),
  ]);
  const leadById = new Map(leadDocs.map((l) => [String(l._id), l]));
  const agentById = new Map(agents.map((a) => [String(a._id), a]));
  return pending
    .map((row) => {
      const lead = leadById.get(String(row.leadId));
      if (!lead) return null;
      const agent = agentById.get(String(row.agentId));
      const neverCalled = !(lead.callCount && lead.callCount > 0) && !lead.lastCalledAt;
      return {
        ...formatLead(lead as ILead, row.assignedAt, agent as never),
        pending_reason: neverCalled ? 'never_called' : 'followup_due',
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);
}

export function leadMatchesSearch(
  lead: Pick<
    ILead,
    | 'name'
    | 'phoneNumber'
    | 'companyName'
    | 'company'
    | 'contactPerson'
    | 'contactMobile'
    | 'state'
    | 'district'
    | 'city'
    | 'leadCode'
  >,
  search?: string
): boolean {
  if (!search?.trim()) return true;
  const term = search.trim().toLowerCase();
  const fields = [
    lead.name,
    lead.phoneNumber,
    lead.companyName,
    lead.company,
    lead.contactPerson,
    lead.contactMobile,
    lead.state,
    lead.district,
    lead.city,
    lead.leadCode,
  ];
  return fields.some((v) => (v ?? '').toLowerCase().includes(term));
}

export function neverWorkedMongo(): Record<string, unknown> {
  return {
    $and: [
      { $or: [{ callCount: { $exists: false } }, { callCount: null }, { callCount: 0 }] },
      { $or: [{ lastCalledAt: { $exists: false } }, { lastCalledAt: null }] },
    ],
  };
}

export function rawTabMongo(): Record<string, unknown> {
  return { $or: [{ callCount: { $exists: false } }, { callCount: null }, { callCount: 0 }] };
}

export function calledTabMongo(): Record<string, unknown> {
  return { callCount: { $gt: 0 } };
}
