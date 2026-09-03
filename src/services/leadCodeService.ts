import { Lead, LeadAssignment } from '../models';

export function initialsFromName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase())
    .join('');
}

/** Next lead code for a telecaller, e.g. "NL-0001". */
export async function getNextLeadCode(agentName: string, agentId: string): Promise<string> {
  const prefix = initialsFromName(agentName);
  if (!prefix) {
    throw new Error('Cannot derive lead code initials from agent name.');
  }

  const assignments = await LeadAssignment.find({ agentId, isActive: true }).select('leadId');
  const leadIds = assignments.map((a) => a.leadId);

  const pattern = new RegExp(`^${prefix}-(\\d+)$`, 'i');
  const leads = await Lead.find({
    _id: { $in: leadIds },
    leadCode: { $exists: true, $ne: null },
  }).select('leadCode');

  let max = 0;
  for (const lead of leads) {
    const code = lead.leadCode;
    if (!code) continue;
    const match = code.match(pattern);
    if (match) {
      max = Math.max(max, parseInt(match[1], 10));
    }
  }

  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}
