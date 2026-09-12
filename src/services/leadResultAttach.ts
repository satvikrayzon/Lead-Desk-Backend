import { Types } from 'mongoose';
import { LeadFollowUp } from '../models';
import { ILead } from '../models/Lead';

/**
 * Ensures each lead has leadResult populated for list cards.
 * Prefers denormalized lead.leadResult; otherwise loads from follow-ups (earliest with a result).
 */
export async function attachLeadResults(leads: ILead[]): Promise<void> {
  if (leads.length === 0) return;

  const missing = leads.filter((l) => !l.leadResult || !String(l.leadResult).trim());
  if (missing.length === 0) return;

  const ids = missing.map((l) => l._id as Types.ObjectId);
  const rows = await LeadFollowUp.find({
    leadId: { $in: ids },
    leadResult: { $exists: true, $nin: [null, ''] },
  })
    .select('leadId leadResult sequenceNumber createdAt')
    .sort({ sequenceNumber: 1, createdAt: 1 })
    .lean();

  const byLead = new Map<string, string>();
  for (const row of rows) {
    const id = String(row.leadId);
    if (byLead.has(id)) continue;
    if (row.leadResult && String(row.leadResult).trim()) {
      byLead.set(id, String(row.leadResult).trim());
    }
  }

  for (const lead of missing) {
    const value = byLead.get(String(lead._id));
    if (value) lead.leadResult = value;
  }
}
