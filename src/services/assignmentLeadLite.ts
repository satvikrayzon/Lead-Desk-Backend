import { Types } from 'mongoose';
import { Lead, LeadAssignment } from '../models';
import { ILead } from '../models/Lead';

/** Fields needed to classify remaining/called and to search/filter lists. */
const LEAD_MATCH_SELECT =
  'name phoneNumber companyName company contactPerson contactMobile state district city leadCode leadStatus leadStage priority customerType product status callCount lastCalledAt nextFollowupDate importRowNumber createdAt';

export type AssignmentLeadRow = {
  leadId: Types.ObjectId;
  agentId: Types.ObjectId;
  assignedAt: Date;
  lead: ILead;
};

export type AgentAssignmentStats = {
  assigned: number;
  called: number;
  remaining: number;
};

function neverWorked(lead: Pick<ILead, 'callCount' | 'lastCalledAt'>): boolean {
  return !(lead.callCount && lead.callCount > 0) && !lead.lastCalledAt;
}

function worked(lead: Pick<ILead, 'callCount' | 'lastCalledAt'>): boolean {
  return (lead.callCount ?? 0) > 0 || Boolean(lead.lastCalledAt);
}

/**
 * Join assignments to leads with two indexed finds.
 * Avoids Mongo `$lookup` + pipeline (a correlated subquery per assignment — 10–40s on ~5k leads).
 */
export async function loadAssignmentLeadRows(
  match: Record<string, unknown>
): Promise<AssignmentLeadRow[]> {
  const assignments = await LeadAssignment.find(match).select('leadId agentId assignedAt').lean();
  if (assignments.length === 0) return [];

  const leadIds = assignments.map((a) => a.leadId);
  const leads = await Lead.find({ _id: { $in: leadIds } })
    .select(LEAD_MATCH_SELECT)
    .lean<ILead[]>();
  const byId = new Map(leads.map((l) => [String(l._id), l]));

  const rows: AssignmentLeadRow[] = [];
  for (const a of assignments) {
    const lead = byId.get(String(a.leadId));
    if (!lead) continue;
    rows.push({
      leadId: a.leadId as Types.ObjectId,
      agentId: a.agentId as Types.ObjectId,
      assignedAt: a.assignedAt,
      lead,
    });
  }
  return rows;
}

export function isPendingLead(lead: Pick<ILead, 'callCount' | 'lastCalledAt' | 'nextFollowupDate'>, tomorrowStart: Date): boolean {
  if (neverWorked(lead)) return true;
  const next = lead.nextFollowupDate;
  return Boolean(next && next < tomorrowStart);
}

export function isCalledLead(lead: Pick<ILead, 'callCount' | 'lastCalledAt'>): boolean {
  return worked(lead);
}

export function isRawLead(lead: Pick<ILead, 'callCount'>): boolean {
  return !(lead.callCount && lead.callCount > 0);
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

  const rows = await loadAssignmentLeadRows({ isActive: true, agentId: { $in: agentIds } });
  for (const row of rows) {
    const key = String(row.agentId);
    const cur = stats.get(key) ?? { assigned: 0, called: 0, remaining: 0 };
    cur.assigned += 1;
    if (worked(row.lead)) cur.called += 1;
    if (isPendingLead(row.lead, tomorrowStart)) cur.remaining += 1;
    stats.set(key, cur);
  }
  return stats;
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
