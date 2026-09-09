import ExcelJS from 'exceljs';
import { Types } from 'mongoose';
import { ILead } from '../models/Lead';
import { ILeadFollowUp, LeadFollowUp } from '../models/LeadFollowUp';

// Exact column order/names from Sales_Lead_Tracker_for_PowerBI new.xlsx -> Lead_Data sheet.
const BASE_COLUMNS: Partial<ExcelJS.Column>[] = [
  { header: 'Lead_ID', key: 'leadCode', width: 12 },
  { header: 'Lead_Date', key: 'leadDate', width: 14 },
  { header: 'Sales_Executive', key: 'salesExecutive', width: 20 },
  { header: 'Team_Leader', key: 'teamLeader', width: 18 },
  { header: 'State', key: 'state', width: 16 },
  { header: 'City', key: 'city', width: 16 },
  { header: 'Customer_Type', key: 'customerType', width: 14 },
  { header: 'Company_Name', key: 'companyName', width: 28 },
  { header: 'Current Installition capacity (in KW)', key: 'currentInstallationCapacityKw', width: 16 },
  { header: 'Contact_Person', key: 'contactPerson', width: 20 },
  { header: 'Designation', key: 'designation', width: 16 },
  { header: 'Mobile', key: 'contactMobile', width: 14 },
  { header: 'Email', key: 'contactEmail', width: 24 },
  { header: 'Customer_Source', key: 'customerSource', width: 16 },
  { header: 'Product', key: 'product', width: 14 },
  { header: 'Requirement_kW', key: 'requirementKw', width: 14 },
  { header: 'Requirement_MW', key: 'requirementMw', width: 14 },
  { header: 'Requirement_Date', key: 'requirementDate', width: 16 },
  { header: 'Current_Brand', key: 'currentBrand', width: 14 },
  { header: 'Current_Supplier', key: 'currentSupplier', width: 16 },
  { header: 'Expected_Price', key: 'expectedPrice', width: 14 },
  { header: 'Delivery_Location', key: 'deliveryLocation', width: 16 },
  { header: 'Lead_Status', key: 'leadStatus', width: 14 },
  { header: 'Lead_Stage', key: 'leadStage', width: 18 },
  { header: 'Priority', key: 'priority', width: 10 },
  { header: 'Dealer_Direct', key: 'dealerDirect', width: 16 },
  { header: 'Assigned_Dealer', key: 'assignedDealer', width: 18 },
  { header: 'Quotation_Date', key: 'quotationDate', width: 14 },
  { header: 'Quotation_Value', key: 'quotationValue', width: 14 },
  { header: 'Expected_Order_Date', key: 'expectedOrderDate', width: 16 },
  { header: 'Probability_%', key: 'probabilityPercent', width: 12 },
  { header: 'Expected_Order_Value', key: 'expectedOrderValue', width: 16 },
  { header: 'Last_Contact_Date', key: 'lastContactDate', width: 16 },
  { header: 'Next_Followup_Date', key: 'nextFollowupDate', width: 16 },
  { header: 'Followup_Remarks', key: 'followupRemarks', width: 30 },
  { header: 'Followup_2 Date', key: 'followup2Date', width: 16 },
  { header: 'Followup_2', key: 'followup2', width: 24 },
  { header: 'Followup_3  Date', key: 'followup3Date', width: 16 },
  { header: 'Followup_3', key: 'followup3', width: 24 },
];

const TAIL_COLUMNS: Partial<ExcelJS.Column>[] = [
  { header: 'Lost_Reason', key: 'lostReason', width: 20 },
  { header: 'Order_Date', key: 'orderDate', width: 14 },
  { header: 'Order_Value', key: 'orderValue', width: 14 },
  { header: 'Order_KW', key: 'orderKw', width: 12 },
  { header: 'Last_Updated', key: 'lastUpdated', width: 16 },
  { header: 'Remarks', key: 'remarks', width: 30 },
];

export interface ExportLeadRow {
  lead: ILead;
  salesExecutive: string;
  teamLeader: string;
  followUps?: ILeadFollowUp[];
}

function dateOnly(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function requirementMw(lead: ILead): number | null {
  if (lead.requirementKw == null) return null;
  return Number(lead.requirementKw) / 1000;
}

function expectedOrderValue(lead: ILead): number | null {
  if (lead.quotationValue == null || lead.probabilityPercent == null) return null;
  return (Number(lead.quotationValue) * Number(lead.probabilityPercent)) / 100;
}

function outcomeLabel(outcome?: string | null): string {
  switch (outcome) {
    case 'received':
      return 'Received';
    case 'notPickup':
    case 'not_pickup':
      return 'Not picked up';
    case 'notConnected':
    case 'not_connected':
      return 'Not connected';
    case 'busy':
      return 'Busy / switched off';
    case 'wrongNumber':
    case 'wrong_number':
      return 'Wrong number';
    case 'decisionMakerConnected':
    case 'decision_maker_connected':
    case 'decision_maker':
      return 'Decision maker';
    default:
      return outcome ? outcome : 'Unknown';
  }
}

function formatFollowUpRemark(f: ILeadFollowUp): string {
  const label = outcomeLabel(f.callOutcome);
  if (label !== 'Unknown') return `[${label}] ${f.remarks}`;
  return f.remarks;
}

function followUpBySequence(followUps: ILeadFollowUp[]): Map<number, ILeadFollowUp> {
  const map = new Map<number, ILeadFollowUp>();
  for (const f of followUps) {
    const seq = f.sequenceNumber ?? map.size + 1;
    map.set(seq, f);
  }
  return map;
}

function buildFollowUpExportFields(lead: ILead, followUps: ILeadFollowUp[]): Record<string, unknown> {
  const bySeq = followUpBySequence(followUps);
  const fields: Record<string, unknown> = {};

  const latest = followUps.length > 0 ? followUps[followUps.length - 1] : null;
  const scheduledNext = [...followUps].reverse().find((f) => f.nextFollowupDate);

  fields.lastContactDate = dateOnly(latest?.createdAt ?? lead.lastContactDate);
  fields.nextFollowupDate = dateOnly(scheduledNext?.nextFollowupDate ?? lead.nextFollowupDate);

  const setPair = (seq: number, dateKey: string, remarkKey: string) => {
    const entry = bySeq.get(seq);
    if (!entry) return;
    fields[dateKey] = dateOnly(entry.createdAt);
    fields[remarkKey] = formatFollowUpRemark(entry);
  };

  const first = bySeq.get(1);
  if (first) fields.followupRemarks = formatFollowUpRemark(first);

  setPair(2, 'followup2Date', 'followup2');
  setPair(3, 'followup3Date', 'followup3');

  for (const [seq, entry] of bySeq.entries()) {
    if (seq <= 3) continue;
    fields[`followup${seq}Date`] = dateOnly(entry.createdAt);
    fields[`followup${seq}`] = formatFollowUpRemark(entry);
  }

  // Fallback to legacy lead columns when no per-call follow-ups exist.
  if (!bySeq.has(1) && lead.followupRemarks) fields.followupRemarks = lead.followupRemarks;
  if (!bySeq.has(2) && lead.followup2) fields.followup2 = lead.followup2;
  if (!bySeq.has(2) && lead.followup2Date) fields.followup2Date = dateOnly(lead.followup2Date);
  if (!bySeq.has(3) && lead.followup3) fields.followup3 = lead.followup3;
  if (!bySeq.has(3) && lead.followup3Date) fields.followup3Date = dateOnly(lead.followup3Date);

  return fields;
}

function buildColumns(maxSequence: number): Partial<ExcelJS.Column>[] {
  const columns = [...BASE_COLUMNS];
  for (let seq = 4; seq <= maxSequence; seq++) {
    columns.push({ header: `Followup_${seq} Date`, key: `followup${seq}Date`, width: 16 });
    columns.push({ header: `Followup_${seq}`, key: `followup${seq}`, width: 24 });
  }
  return [...columns, ...TAIL_COLUMNS];
}

/** Load all follow-up entries for export, grouped by lead id. */
export async function loadFollowUpsByLeadId(
  leadIds: Types.ObjectId[] | string[]
): Promise<Map<string, ILeadFollowUp[]>> {
  if (leadIds.length === 0) return new Map();

  const followUps = await LeadFollowUp.find({ leadId: { $in: leadIds } }).sort({
    sequenceNumber: 1,
    createdAt: 1,
  });

  const byLead = new Map<string, ILeadFollowUp[]>();
  for (const f of followUps) {
    const id = f.leadId.toString();
    const list = byLead.get(id) ?? [];
    list.push(f);
    byLead.set(id, list);
  }
  return byLead;
}

export async function buildLeadTrackerWorkbook(rows: ExportLeadRow[]): Promise<Buffer> {
  const maxSequence = Math.max(
    3,
    ...rows.map((r) => {
      const list = r.followUps ?? [];
      return list.reduce((max, f) => Math.max(max, f.sequenceNumber ?? 0), 0);
    })
  );

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Lead_Data');
  sheet.columns = buildColumns(maxSequence);
  sheet.getRow(1).font = { bold: true };

  for (const { lead, salesExecutive, teamLeader, followUps = [] } of rows) {
    const followUpFields = buildFollowUpExportFields(lead, followUps);

    sheet.addRow({
      leadCode: lead.leadCode,
      leadDate: dateOnly(lead.leadDate),
      salesExecutive: lead.salesExecutive || salesExecutive,
      teamLeader: lead.teamLeader || teamLeader,
      state: lead.state,
      city: lead.city,
      customerType: lead.customerType,
      companyName: lead.companyName ?? lead.company ?? lead.name,
      currentInstallationCapacityKw: lead.currentInstallationCapacityKw,
      contactPerson: lead.contactPerson ?? lead.name,
      designation: lead.designation,
      contactMobile: lead.contactMobile ?? lead.phoneNumber,
      contactEmail: lead.contactEmail,
      customerSource: lead.customerSource,
      product: lead.product,
      requirementKw: lead.requirementKw,
      requirementMw: requirementMw(lead),
      requirementDate: dateOnly(lead.requirementDate),
      currentBrand: lead.currentBrand,
      currentSupplier: lead.currentSupplier,
      expectedPrice: lead.expectedPrice,
      deliveryLocation: lead.deliveryLocation,
      leadStatus: lead.leadStatus,
      leadStage: lead.leadStage,
      priority: lead.priority,
      dealerDirect: lead.dealerDirect,
      assignedDealer: lead.assignedDealer,
      quotationDate: dateOnly(lead.quotationDate),
      quotationValue: lead.quotationValue,
      expectedOrderDate: dateOnly(lead.expectedOrderDate),
      probabilityPercent: lead.probabilityPercent,
      expectedOrderValue: expectedOrderValue(lead),
      ...followUpFields,
      lostReason: lead.lostReason,
      orderDate: dateOnly(lead.orderDate),
      orderValue: lead.orderValue,
      orderKw: lead.orderKw,
      lastUpdated: dateOnly(lead.lastCalledAt),
      remarks: lead.remarks,
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
