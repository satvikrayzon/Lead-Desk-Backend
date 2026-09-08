import { ILead } from '../models/Lead';

import { IUser } from '../models/User';

import { LeadAssignment } from '../models';

import { AuditLog } from '../models';

import { LeadStatus } from '../types/enums';



export interface LeadResponse {

  id: string;

  lead_code: string | null;

  company_name: string;

  contact_person: string | null;

  contact_email: string | null;

  contact_mobile: string;

  vendor_id: string | null;

  address: string | null;

  website: string | null;

  rating: number | null;

  rating_count: number | null;

  current_installation_capacity_kw: number | null;

  installations_count: number | null;

  state: string | null;

  district: string | null;

  city: string | null;

  call_count: number;

  last_called_at: string | null;

  assigned_to: { id: string; name: string; email: string } | null;

  team: { id: string | null; name: string | null } | null;

  sales_executive: string | null;

  team_leader: string | null;

  lead_date: string | null;

  designation: string | null;

  customer_type: string | null;

  customer_source: string | null;

  product: string | null;

  requirement_kw: number | null;

  requirement_mw: number | null;

  requirement_date: string | null;

  current_brand: string | null;

  current_supplier: string | null;

  expected_price: number | null;

  delivery_location: string | null;

  lead_status: string;

  lead_stage: string | null;

  priority: string | null;

  dealer_direct: string | null;

  assigned_dealer: string | null;

  quotation_date: string | null;

  quotation_value: number | null;

  expected_order_date: string | null;

  probability_percent: number | null;

  expected_order_value: number | null;

  last_contact_date: string | null;

  next_followup_date: string | null;

  followup_remarks: string | null;

  followup_2_date: string | null;

  followup_2: string | null;

  followup_3_date: string | null;

  followup_3: string | null;

  lost_reason: string | null;

  order_date: string | null;

  order_value: number | null;

  order_kw: number | null;

  remarks: string | null;

  last_form_fill_seconds: number | null;

  avg_form_fill_seconds: number | null;

  // Legacy fields kept for older clients.

  name: string;

  phone_number: string;

  status: string;

  notes: string | null;

  assigned_at: string;

  company: string | null;

  import_batch_id: string | null;

  import_row_number: number | null;

  created_at: string;

  updated_at: string;

}



function toIso(d: Date | undefined | null): string | null {

  return d ? d.toISOString() : null;

}



function requirementMw(lead: ILead): number | null {

  if (lead.requirementKw == null) return null;

  return Number(lead.requirementKw) / 1000;

}



function expectedOrderValue(lead: ILead): number | null {

  if (lead.quotationValue == null || lead.probabilityPercent == null) return null;

  return (Number(lead.quotationValue) * Number(lead.probabilityPercent)) / 100;

}



export function formatLead(lead: ILead, assignedAt: Date, agent?: IUser | null): LeadResponse {

  const companyName = lead.companyName ?? lead.company ?? lead.name;

  const contactMobile = lead.contactMobile ?? lead.phoneNumber;

  return {

    id: lead._id.toString(),

    lead_code: lead.leadCode ?? null,

    company_name: companyName,

    contact_person: lead.contactPerson ?? lead.name ?? null,

    contact_email: lead.contactEmail ?? null,

    contact_mobile: contactMobile,

    vendor_id: lead.vendorId ?? null,

    address: lead.address ?? null,

    website: lead.website ?? null,

    rating: lead.rating ?? null,

    rating_count: lead.ratingCount ?? null,

    current_installation_capacity_kw: lead.currentInstallationCapacityKw ?? null,

    installations_count: lead.installationsCount ?? null,

    state: lead.state ?? null,

    district: lead.district ?? null,

    city: lead.city ?? null,

    call_count: lead.callCount ?? 0,

    last_called_at: toIso(lead.lastCalledAt),

    assigned_to: agent

      ? { id: agent._id.toString(), name: agent.name, email: agent.email }

      : null,

    team: agent?.teamName ? { id: null, name: agent.teamName } : null,

    sales_executive: lead.salesExecutive ?? agent?.name ?? null,

    team_leader: lead.teamLeader ?? agent?.teamName ?? null,

    lead_date: toIso(lead.leadDate),

    designation: lead.designation ?? null,

    customer_type: lead.customerType ?? null,

    customer_source: lead.customerSource ?? null,

    product: lead.product ?? null,

    requirement_kw: lead.requirementKw ?? null,

    requirement_mw: requirementMw(lead),

    requirement_date: toIso(lead.requirementDate),

    current_brand: lead.currentBrand ?? null,

    current_supplier: lead.currentSupplier ?? null,

    expected_price: lead.expectedPrice ?? null,

    delivery_location: lead.deliveryLocation ?? null,

    lead_status: lead.leadStatus ?? 'Open',

    lead_stage: lead.leadStage ?? null,

    priority: lead.priority ?? null,

    dealer_direct: lead.dealerDirect ?? null,

    assigned_dealer: lead.assignedDealer ?? null,

    quotation_date: toIso(lead.quotationDate),

    quotation_value: lead.quotationValue ?? null,

    expected_order_date: toIso(lead.expectedOrderDate),

    probability_percent: lead.probabilityPercent ?? null,

    expected_order_value: expectedOrderValue(lead),

    last_contact_date: toIso(lead.lastContactDate),

    next_followup_date: toIso(lead.nextFollowupDate),

    followup_remarks: lead.followupRemarks ?? null,

    followup_2_date: toIso(lead.followup2Date),

    followup_2: lead.followup2 ?? null,

    followup_3_date: toIso(lead.followup3Date),

    followup_3: lead.followup3 ?? null,

    lost_reason: lead.lostReason ?? null,

    order_date: toIso(lead.orderDate),

    order_value: lead.orderValue ?? null,

    order_kw: lead.orderKw ?? null,

    remarks: lead.remarks ?? null,

    last_form_fill_seconds:
      typeof lead.lastFormFillSeconds === 'number' ? lead.lastFormFillSeconds : null,

    avg_form_fill_seconds:
      typeof lead.avgFormFillSeconds === 'number' ? lead.avgFormFillSeconds : null,

    name: lead.name,

    phone_number: lead.phoneNumber,

    status: lead.status,

    notes: lead.notes ?? null,

    assigned_at: assignedAt.toISOString(),

    company: lead.company ?? companyName ?? null,

    import_batch_id: lead.importBatchId?.toString() ?? null,

    import_row_number:
      typeof lead.importRowNumber === 'number' ? lead.importRowNumber : null,

    created_at: lead.createdAt.toISOString(),

    updated_at: lead.updatedAt.toISOString(),

  };

}



export async function isLeadAssignedToAgent(leadId: string, agentId: string): Promise<boolean> {

  const assignment = await LeadAssignment.findOne({

    leadId,

    agentId,

    isActive: true,

  });

  return !!assignment;

}



export async function getActiveAssignment(leadId: string, agentId: string) {

  return LeadAssignment.findOne({ leadId, agentId, isActive: true });

}



export function isValidLeadStatus(status: string): status is LeadStatus {

  const valid = ['new', 'interested', 'not_reachable', 'follow_up', 'not_interested', 'converted'];

  return valid.includes(status);

}



export function extractPhoneDigits(phone: string): string {

  return phone.replace(/\D/g, '');

}



export function buildRecordingS3Key(params: {

  agentId: string;

  leadId: string;

  phoneNumber: string;

  callStartTime: Date;

  extension?: string;

}): string {

  const { agentId, leadId, phoneNumber, callStartTime } = params;

  const ext = params.extension || 'm4a';

  const yyyy = callStartTime.getUTCFullYear();

  const mm = String(callStartTime.getUTCMonth() + 1).padStart(2, '0');

  const dd = String(callStartTime.getUTCDate()).padStart(2, '0');

  const phoneDigits = extractPhoneDigits(phoneNumber);

  const timestamp = callStartTime.getTime();



  return `recordings/${agentId}/${leadId}/${yyyy}/${mm}/${dd}/${leadId}_${phoneDigits}_${timestamp}.${ext}`;

}



export async function createAuditLog(params: {

  userId?: string;

  action: string;

  entityType: string;

  entityId: string;

  metadata?: Record<string, unknown>;

  ipAddress?: string;

}) {

  await AuditLog.create({

    userId: params.userId,

    action: params.action,

    entityType: params.entityType,

    entityId: params.entityId,

    metadata: params.metadata,

    ipAddress: params.ipAddress,

  });

}



export function isDuplicateKeyError(err: unknown): boolean {

  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

}



export function parseOptionalDate(value: unknown): Date | undefined {

  if (value === null || value === undefined || value === '') return undefined;

  const d = new Date(value as string);

  if (Number.isNaN(d.getTime())) return undefined;

  return d;

}



export function parseOptionalNumber(value: unknown): number | undefined {

  if (value === null || value === undefined || value === '') return undefined;

  const n = Number(value);

  if (Number.isNaN(n)) return undefined;

  return n;

}



export function parseOptionalString(value: unknown): string | undefined {

  if (value === null || value === undefined) return undefined;

  const s = String(value).trim();

  return s === '' ? undefined : s;

}


