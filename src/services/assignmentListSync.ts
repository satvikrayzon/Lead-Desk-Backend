import { Types } from 'mongoose';
import { Lead, LeadAssignment } from '../models';
import { ILead } from '../models/Lead';

export type AssignmentListFields = {
  callCount: number;
  lastCalledAt: Date | null;
  importRowNumber: number;
  nextFollowupDate: Date | null;
  state: string | null;
  district: string | null;
  city: string | null;
  leadStatus: string | null;
  leadStage: string | null;
  priority: string | null;
  customerType: string | null;
  product: string | null;
  companyName: string | null;
  contactPerson: string | null;
  contactMobile: string | null;
  leadCode: string | null;
  listSyncedAt: Date;
};

const LIST_SELECT =
  'callCount lastCalledAt importRowNumber nextFollowupDate state district city leadStatus leadStage priority customerType product companyName company name contactPerson contactMobile phoneNumber leadCode';

export function listFieldsFromLead(lead: Partial<ILead>): AssignmentListFields {
  return {
    callCount: lead.callCount ?? 0,
    lastCalledAt: lead.lastCalledAt ?? null,
    importRowNumber: lead.importRowNumber ?? 999999999,
    nextFollowupDate: lead.nextFollowupDate ?? null,
    state: lead.state ?? null,
    district: lead.district ?? null,
    city: lead.city ?? null,
    leadStatus: lead.leadStatus ?? null,
    leadStage: lead.leadStage ?? null,
    priority: lead.priority ?? null,
    customerType: lead.customerType ?? null,
    product: lead.product ?? null,
    companyName: lead.companyName ?? lead.company ?? lead.name ?? null,
    contactPerson: lead.contactPerson ?? null,
    contactMobile: lead.contactMobile ?? lead.phoneNumber ?? null,
    leadCode: lead.leadCode ?? null,
    listSyncedAt: new Date(),
  };
}

export function listFieldsFromAssignment(row: {
  callCount?: number | null;
  lastCalledAt?: Date | null;
  importRowNumber?: number | null;
  nextFollowupDate?: Date | null;
  state?: string | null;
  district?: string | null;
  city?: string | null;
  leadStatus?: string | null;
  leadStage?: string | null;
  priority?: string | null;
  customerType?: string | null;
  product?: string | null;
  companyName?: string | null;
  contactPerson?: string | null;
  contactMobile?: string | null;
  leadCode?: string | null;
}): AssignmentListFields {
  return {
    callCount: row.callCount ?? 0,
    lastCalledAt: row.lastCalledAt ?? null,
    importRowNumber: row.importRowNumber ?? 999999999,
    nextFollowupDate: row.nextFollowupDate ?? null,
    state: row.state ?? null,
    district: row.district ?? null,
    city: row.city ?? null,
    leadStatus: row.leadStatus ?? null,
    leadStage: row.leadStage ?? null,
    priority: row.priority ?? null,
    customerType: row.customerType ?? null,
    product: row.product ?? null,
    companyName: row.companyName ?? null,
    contactPerson: row.contactPerson ?? null,
    contactMobile: row.contactMobile ?? null,
    leadCode: row.leadCode ?? null,
    listSyncedAt: new Date(),
  };
}

export function assignmentInsertFromLead(input: {
  lead: Partial<ILead> & { _id: Types.ObjectId };
  agentId: Types.ObjectId | string;
  assignedBy?: Types.ObjectId | string;
  assignedAt?: Date;
}): Record<string, unknown> {
  return {
    leadId: input.lead._id,
    agentId: input.agentId,
    assignedBy: input.assignedBy,
    assignedAt: input.assignedAt ?? new Date(),
    isActive: true,
    ...listFieldsFromLead(input.lead),
  };
}

export async function syncAssignmentsForLead(leadId: string | Types.ObjectId): Promise<void> {
  if (!Types.ObjectId.isValid(String(leadId))) return;
  const lead = await Lead.findById(leadId).select(LIST_SELECT).lean<ILead | null>();
  if (!lead) return;
  await LeadAssignment.updateMany({ leadId: lead._id, isActive: true }, { $set: listFieldsFromLead(lead) });
}

let backfillPromise: Promise<void> | null = null;

export function ensureAssignmentListBackfill(): Promise<void> {
  if (!backfillPromise) {
    backfillPromise = backfillAssignmentListFields().catch((err) => {
      backfillPromise = null;
      throw err;
    });
  }
  return backfillPromise;
}

async function syncBatch(
  rows: Array<{ _id: Types.ObjectId; leadId: Types.ObjectId }>
): Promise<void> {
  const leadIds = [...new Set(rows.map((r) => String(r.leadId)))].map((id) => new Types.ObjectId(id));
  const leads = await Lead.find({ _id: { $in: leadIds } })
    .select(LIST_SELECT)
    .lean<ILead[]>();
  const byId = new Map(leads.map((l) => [String(l._id), l]));
  const ops = rows.map((row) => {
    const lead = byId.get(String(row.leadId));
    const fields = lead
      ? listFieldsFromLead(lead)
      : { callCount: 0, lastCalledAt: null, importRowNumber: 999999999, listSyncedAt: new Date() };
    return {
      updateOne: {
        filter: { _id: row._id },
        update: { $set: fields },
      },
    };
  });
  if (ops.length > 0) {
    await LeadAssignment.bulkWrite(ops, { ordered: false });
  }
}

export async function backfillAssignmentListFields(): Promise<void> {
  const unsynced = await LeadAssignment.countDocuments({
    isActive: true,
    $or: [{ listSyncedAt: { $exists: false } }, { listSyncedAt: null }],
  });
  if (unsynced === 0) return;

  console.log(`[leads] backfilling list fields on ${unsynced} assignments`);
  const cursor = LeadAssignment.find({
    isActive: true,
    $or: [{ listSyncedAt: { $exists: false } }, { listSyncedAt: null }],
  })
    .select('leadId')
    .lean()
    .cursor();

  let batch: Array<{ _id: Types.ObjectId; leadId: Types.ObjectId }> = [];
  let done = 0;
  for await (const row of cursor) {
    batch.push({ _id: row._id as Types.ObjectId, leadId: row.leadId as Types.ObjectId });
    if (batch.length >= 200) {
      await syncBatch(batch);
      done += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    await syncBatch(batch);
    done += batch.length;
  }
  console.log(`[leads] list-field backfill complete (${done})`);
}
