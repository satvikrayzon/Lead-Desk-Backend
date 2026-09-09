import ExcelJS from 'exceljs';
import { Types } from 'mongoose';
import { CallRecording, Lead, LeadAssignment, LeadFollowUp, RemoteCall, User } from '../models';

export type DailySalesReport = {
  employee: {
    id: string;
    name: string;
    email: string | null;
    team_name: string | null;
  };
  date: string;
  date_display: string;
  date_from: string;
  date_to: string;
  state_region: string | null;
  target_area: string | null;
  calling: {
    calls_attempted: number;
    calls_connected: number;
    no_answer: number;
    busy_switched_off: number;
    wrong_number: number;
    decision_maker_connected: number;
    total_leads_assigned: number;
  };
  lead_sales: {
    interested: number;
    not_interested: number;
    follow_up_required: number;
    qualified_leads: number;
    rate_provided: number;
    closed_order_received: number;
    estimated_sales_value: number;
  };
  next_follow_up: {
    total_follow_up_calls: number;
  };
  key_remarks: Array<{
    company_name: string;
    remarks: string;
    lead_code: string | null;
  }>;
  talk_seconds: number;
  calls_detail_count: number;
  data_sources: {
    recordings: number;
    remote_calls: number;
    follow_ups: number;
  };
};

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function dateKey(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateDisplay(d: Date) {
  const day = String(d.getDate()).padStart(2, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}-${m}-${d.getFullYear()}`;
}

export function parseReportDay(raw: unknown): Date {
  if (typeof raw === 'string' && raw.trim()) {
    const parts = raw.trim().split('-').map((p) => Number(p));
    if (parts.length === 3 && !parts.some((n) => Number.isNaN(n))) {
      return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
    }
  }
  return startOfDay();
}

/** Inclusive calendar range: from 00:00 of fromDay through 00:00 of day after toDay. */
export function parseReportRange(query: {
  date?: unknown;
  from?: unknown;
  to?: unknown;
}): { rangeStart: Date; rangeEndExclusive: Date; fromKey: string; toKey: string } {
  const fromDay = parseReportDay(query.from ?? query.date);
  let toDay = parseReportDay(query.to ?? query.from ?? query.date);
  if (toDay < fromDay) toDay = fromDay;
  const rangeEndExclusive = new Date(toDay);
  rangeEndExclusive.setDate(rangeEndExclusive.getDate() + 1);
  return {
    rangeStart: fromDay,
    rangeEndExclusive,
    fromKey: dateKey(fromDay),
    toKey: dateKey(toDay),
  };
}

function normalizeOutcome(raw: string | undefined | null): string {
  const v = (raw || 'unknown').trim();
  if (v === 'not_pickup') return 'notPickup';
  if (v === 'not_connected') return 'notConnected';
  if (v === 'wrong_number') return 'wrongNumber';
  if (v === 'decision_maker' || v === 'decision_maker_connected') return 'decisionMakerConnected';
  // New UI labels stored as same db values
  if (v === 'connected') return 'received';
  if (v === 'no_answer' || v === 'noAnswer') return 'notPickup';
  return v || 'unknown';
}

function outcomeFromRemoteStatus(status: string): string {
  switch (status) {
    case 'ended':
    case 'active':
      return 'received';
    case 'no_answer':
      return 'notPickup';
    case 'busy':
      return 'busy';
    case 'failed':
    case 'rejected':
      return 'notConnected';
    default:
      return 'unknown';
  }
}

function modeString(values: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) {
    const s = (v || '').trim();
    if (!s) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function expectedValue(lead: {
  quotationValue?: number | null;
  probabilityPercent?: number | null;
  orderValue?: number | null;
}): number {
  if (lead.orderValue != null && Number(lead.orderValue) > 0) {
    return Number(lead.orderValue);
  }
  if (lead.quotationValue != null && lead.probabilityPercent != null) {
    return (Number(lead.quotationValue) * Number(lead.probabilityPercent)) / 100;
  }
  if (lead.quotationValue != null) return Number(lead.quotationValue);
  return 0;
}

function normalizeLeadResult(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  const map: Record<string, string> = {
    interested: 'interested',
    not_interested: 'not_interested',
    'not interested': 'not_interested',
    follow_up_required: 'follow_up_required',
    'follow-up required': 'follow_up_required',
    followup_required: 'follow_up_required',
    qualified: 'qualified',
    'qualified lead': 'qualified',
    rate_provided: 'rate_provided',
    'rate provided': 'rate_provided',
    closed: 'closed',
    'closed / order received': 'closed',
    order_received: 'closed',
  };
  return map[v] ?? null;
}

function refLeadId(ref: unknown): string {
  if (ref == null) return '';
  if (typeof ref === 'object' && ref !== null && '_id' in (ref as object)) {
    return String((ref as { _id: unknown })._id);
  }
  return String(ref);
}

type CallBuckets = {
  attempted: number;
  connected: number;
  noAnswer: number;
  busy: number;
  wrongNumber: number;
  decisionMaker: number;
  talkSeconds: number;
};

function emptyCallBuckets(): CallBuckets {
  return {
    attempted: 0,
    connected: 0,
    noAnswer: 0,
    busy: 0,
    wrongNumber: 0,
    decisionMaker: 0,
    talkSeconds: 0,
  };
}

/** Classify a single dial into report buckets (form outcome preferred). */
function classifyDial(bucket: CallBuckets, outcomeRaw: string, talkSeconds = 0) {
  bucket.attempted += 1;
  bucket.talkSeconds += Math.max(0, talkSeconds);
  const outcome = normalizeOutcome(outcomeRaw);
  switch (outcome) {
    case 'received':
      bucket.connected += 1;
      break;
    case 'decisionMakerConnected':
      bucket.connected += 1;
      bucket.decisionMaker += 1;
      break;
    case 'notPickup':
      bucket.noAnswer += 1;
      break;
    case 'busy':
    case 'notConnected':
      bucket.busy += 1;
      break;
    case 'wrongNumber':
      bucket.wrongNumber += 1;
      break;
    default:
      // Still counts as attempted even if status unknown.
      break;
  }
}

/**
 * Build daily/range sales report.
 *
 * Calling performance:
 *  - Attempted = every dial (recording / Windows remote / follow-up-only)
 *  - Connected / No Answer / Busy / Wrong Number = telecaller call-status on the form
 *    when present; else recording/remote inferred status
 *
 * Lead & sales status:
 *  - Counts from follow-up form `lead_result` dropdown for the period
 */
export async function buildDailySalesReport(
  agentId: string,
  rangeStart: Date,
  rangeEndExclusive: Date
): Promise<DailySalesReport> {
  if (!Types.ObjectId.isValid(agentId)) {
    throw new Error('Invalid agent id');
  }

  const user = await User.findById(agentId).select('name email teamName');
  if (!user) throw new Error('Telecaller not found');

  const fromKey = dateKey(rangeStart);
  const toKey = dateKey(new Date(rangeEndExclusive.getTime() - 1));
  const dateDisplayStr =
    fromKey === toKey ? dateDisplay(rangeStart) : `${dateDisplay(rangeStart)} → ${dateDisplay(new Date(rangeEndExclusive.getTime() - 1))}`;

  const [assignments, recordings, remoteCalls, followUps] = await Promise.all([
    LeadAssignment.find({ agentId, isActive: true }).select('leadId'),
    CallRecording.find({
      agentId,
      callStartTime: { $gte: rangeStart, $lt: rangeEndExclusive },
    }).select('leadId durationSeconds callOutcome clientCallId'),
    RemoteCall.find({
      agentId,
      startTime: { $gte: rangeStart, $lt: rangeEndExclusive },
      status: { $in: ['ended', 'busy', 'rejected', 'failed', 'no_answer'] },
    }).select('leadId durationSeconds status callId'),
    LeadFollowUp.find({
      agentId,
      createdAt: { $gte: rangeStart, $lt: rangeEndExclusive },
    })
      .select('leadId remarks nextFollowupDate callOutcome leadResult clientCallId callRecordingId')
      .populate(
        'leadId',
        'companyName leadCode leadStage leadStatus status quotationValue probabilityPercent orderValue state district city'
      ),
  ]);

  const assignedLeadIds = assignments.map((a) => a.leadId);
  const assignedLeads =
    assignedLeadIds.length > 0
      ? await Lead.find({ _id: { $in: assignedLeadIds } }).select('state district city')
      : [];

  // Map follow-up outcomes by recording id / client call id for preference.
  const fuByRecordingId = new Map<string, string>();
  const fuByClientCallId = new Map<string, string>();
  const fuLeadKeysCounted = new Set<string>();

  for (const f of followUps) {
    const outcome = normalizeOutcome(f.callOutcome);
    if (f.callRecordingId) fuByRecordingId.set(f.callRecordingId.toString(), outcome);
    if (f.clientCallId) fuByClientCallId.set(f.clientCallId, outcome);
  }

  const bucket = emptyCallBuckets();
  const touchedLeadIds = new Set<string>();
  const countedKeys = new Set<string>();

  for (const c of recordings) {
    const id = c._id.toString();
    const leadKey = c.leadId?.toString() || '';
    if (leadKey) touchedLeadIds.add(leadKey);
    countedKeys.add(`rec:${id}`);
    if (c.clientCallId) countedKeys.add(`client:${c.clientCallId}`);
    const formOutcome = fuByRecordingId.get(id) || (c.clientCallId ? fuByClientCallId.get(c.clientCallId) : undefined);
    classifyDial(bucket, formOutcome || c.callOutcome || 'unknown', c.durationSeconds || 0);
    if (leadKey) fuLeadKeysCounted.add(leadKey);
  }

  for (const c of remoteCalls) {
    const callId = c.callId;
    if (callId && countedKeys.has(`client:${callId}`)) continue;
    const leadKey = c.leadId?.toString() || '';
    // Skip if a recording for same lead already counted and remote has no distinct client id match
    if (callId) countedKeys.add(`client:${callId}`);
    countedKeys.add(`remote:${c._id.toString()}`);
    if (leadKey) touchedLeadIds.add(leadKey);
    const formOutcome = callId ? fuByClientCallId.get(callId) : undefined;
    classifyDial(bucket, formOutcome || outcomeFromRemoteStatus(c.status), c.durationSeconds || 0);
  }

  // Follow-ups that represent a call with no recording/remote row (common on Windows).
  let followUpsAsCalls = 0;
  for (const f of followUps) {
    const clientId = f.clientCallId;
    if (clientId && countedKeys.has(`client:${clientId}`)) continue;
    if (f.callRecordingId && countedKeys.has(`rec:${f.callRecordingId.toString()}`)) continue;
    const outcome = normalizeOutcome(f.callOutcome);
    if (outcome === 'unknown') continue;
    countedKeys.add(`fu:${f._id.toString()}`);
    if (clientId) countedKeys.add(`client:${clientId}`);
    const leadKey = refLeadId(f.leadId);
    if (leadKey) touchedLeadIds.add(leadKey);
    classifyDial(bucket, outcome, 0);
    followUpsAsCalls += 1;
  }

  // Lead & sales from lead_result dropdown on follow-ups in range.
  let interested = 0;
  let notInterested = 0;
  let followUpRequired = 0;
  let qualified = 0;
  let rateProvided = 0;
  let closed = 0;
  let nextFollowUps = 0;
  const keyRemarks: DailySalesReport['key_remarks'] = [];
  const valuedLeadIds = new Set<string>();

  for (const f of followUps) {
    const result = normalizeLeadResult(f.leadResult);
    switch (result) {
      case 'interested':
        interested += 1;
        break;
      case 'not_interested':
        notInterested += 1;
        break;
      case 'follow_up_required':
        followUpRequired += 1;
        break;
      case 'qualified':
        qualified += 1;
        break;
      case 'rate_provided':
        rateProvided += 1;
        break;
      case 'closed':
        closed += 1;
        break;
      default:
        break;
    }

    if (f.nextFollowupDate) nextFollowUps += 1;

    const remarks = (f.remarks || '').trim();
    if (remarks) {
      const lead = f.leadId as unknown as { companyName?: string; leadCode?: string } | null;
      keyRemarks.push({
        company_name: lead?.companyName || '—',
        remarks,
        lead_code: lead?.leadCode ?? null,
      });
    }

    const leadKey = refLeadId(f.leadId);
    if (leadKey) touchedLeadIds.add(leadKey);
  }

  const touchedLeads =
    touchedLeadIds.size > 0
      ? await Lead.find({ _id: { $in: [...touchedLeadIds] } }).select(
          'quotationValue probabilityPercent orderValue state district city'
        )
      : [];

  let estimatedSales = 0;
  for (const lead of touchedLeads) {
    const id = lead._id.toString();
    if (valuedLeadIds.has(id)) continue;
    valuedLeadIds.add(id);
    estimatedSales += expectedValue(lead);
  }

  const stateRegion =
    modeString(touchedLeads.map((l) => l.state)) ||
    modeString(assignedLeads.map((l) => l.state)) ||
    modeString(touchedLeads.map((l) => l.district)) ||
    modeString(assignedLeads.map((l) => l.district));
  const targetArea =
    modeString(touchedLeads.map((l) => l.district || l.city)) ||
    modeString(assignedLeads.map((l) => l.district || l.city));

  return {
    employee: {
      id: user._id.toString(),
      name: user.name,
      email: user.email ?? null,
      team_name: user.teamName ?? null,
    },
    date: fromKey,
    date_display: dateDisplayStr,
    date_from: fromKey,
    date_to: toKey,
    state_region: stateRegion,
    target_area: targetArea,
    calling: {
      calls_attempted: bucket.attempted,
      calls_connected: bucket.connected,
      no_answer: bucket.noAnswer,
      busy_switched_off: bucket.busy,
      wrong_number: bucket.wrongNumber,
      decision_maker_connected: bucket.decisionMaker,
      total_leads_assigned: assignments.length,
    },
    lead_sales: {
      interested,
      not_interested: notInterested,
      follow_up_required: followUpRequired,
      qualified_leads: qualified,
      rate_provided: rateProvided,
      closed_order_received: closed,
      estimated_sales_value: Math.round(estimatedSales * 100) / 100,
    },
    next_follow_up: {
      total_follow_up_calls: nextFollowUps || followUpRequired,
    },
    key_remarks: keyRemarks.slice(0, 50),
    talk_seconds: bucket.talkSeconds,
    calls_detail_count: bucket.attempted,
    data_sources: {
      recordings: recordings.length,
      remote_calls: remoteCalls.length,
      follow_ups: followUpsAsCalls,
    },
  };
}

/** @deprecated Prefer range overload via parseReportRange. */
export async function buildDailySalesReportForDay(agentId: string, dayStart: Date): Promise<DailySalesReport> {
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  return buildDailySalesReport(agentId, dayStart, dayEnd);
}

export async function buildAllDailySalesReports(
  rangeStart: Date,
  rangeEndExclusive: Date
): Promise<DailySalesReport[]> {
  const agents = await User.find({
    role: { $in: ['agent', 'manager'] },
    isActive: true,
  })
    .select('_id')
    .sort({ name: 1 });

  return Promise.all(
    agents.map((agent) => buildDailySalesReport(agent._id.toString(), rangeStart, rangeEndExclusive))
  );
}

export function formatDailySalesReportText(report: DailySalesReport): string {
  const c = report.calling;
  const s = report.lead_sales;
  const remarks =
    report.key_remarks.length === 0
      ? '—'
      : report.key_remarks
          .map((r) => {
            const code = r.lead_code ? ` (${r.lead_code})` : '';
            return `• ${r.company_name}${code}: ${r.remarks}`;
          })
          .join('\n');

  return [
    '📊 DAILY SALES TELECALLING REPORT',
    '',
    `📅 Date: ${report.date_display}`,
    `👤 Employee: ${report.employee.name}`,
    `📍 State/Region: ${report.state_region || '—'}`,
    `🎯 Target Area: ${report.target_area || '—'}`,
    '',
    '📞 CALLING PERFORMANCE',
    '',
    `• Calls Attempted: ${c.calls_attempted}`,
    `• Calls Connected: ${c.calls_connected}`,
    `• No Answer: ${c.no_answer}`,
    `• Busy/Switched Off: ${c.busy_switched_off}`,
    `• Wrong Number: ${c.wrong_number}`,
    `• Decision Maker Connected: ${c.decision_maker_connected}`,
    `• Total Leads Assigned: ${c.total_leads_assigned}`,
    '',
    '',
    '🎯 LEAD & SALES STATUS',
    '',
    `• Interested: ${s.interested}`,
    `• Not Interested: ${s.not_interested}`,
    `• Follow-up Required: ${s.follow_up_required}`,
    `• Qualified Leads: ${s.qualified_leads}`,
    `• Rate Provided: ${s.rate_provided}`,
    `• Closed/Order Received: ${s.closed_order_received}`,
    `• Estimated Sales Value: ₹${s.estimated_sales_value}`,
    '',
    '📅 NEXT FOLLOW-UP',
    '',
    `• Total Follow-up Calls: ${report.next_follow_up.total_follow_up_calls}`,
    '',
    '',
    '📝 KEY REMARKS',
    remarks,
  ].join('\n');
}

export async function buildDailySalesReportWorkbook(reports: DailySalesReport[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lead Desk';
  wb.created = new Date();

  const summary = wb.addWorksheet('Daily_Summary');
  summary.columns = [
    { header: 'Date From', key: 'from', width: 12 },
    { header: 'Date To', key: 'to', width: 12 },
    { header: 'Employee', key: 'employee', width: 22 },
    { header: 'Team', key: 'team', width: 16 },
    { header: 'State/Region', key: 'state', width: 16 },
    { header: 'Target Area', key: 'area', width: 16 },
    { header: 'Calls Attempted', key: 'attempted', width: 14 },
    { header: 'Calls Connected', key: 'connected', width: 14 },
    { header: 'No Answer', key: 'noAnswer', width: 12 },
    { header: 'Busy/Switched Off', key: 'busy', width: 16 },
    { header: 'Wrong Number', key: 'wrong', width: 12 },
    { header: 'Leads Assigned', key: 'assigned', width: 14 },
    { header: 'Interested', key: 'interested', width: 12 },
    { header: 'Not Interested', key: 'notInterested', width: 14 },
    { header: 'Follow-up Required', key: 'fuReq', width: 16 },
    { header: 'Qualified', key: 'qualified', width: 12 },
    { header: 'Rate Provided', key: 'rate', width: 12 },
    { header: 'Closed/Order', key: 'closed', width: 12 },
    { header: 'Estimated Sales Value', key: 'value', width: 18 },
    { header: 'Next Follow-ups', key: 'nextFu', width: 14 },
  ];

  for (const r of reports) {
    summary.addRow({
      from: r.date_from,
      to: r.date_to,
      employee: r.employee.name,
      team: r.employee.team_name || '',
      state: r.state_region || '',
      area: r.target_area || '',
      attempted: r.calling.calls_attempted,
      connected: r.calling.calls_connected,
      noAnswer: r.calling.no_answer,
      busy: r.calling.busy_switched_off,
      wrong: r.calling.wrong_number,
      assigned: r.calling.total_leads_assigned,
      interested: r.lead_sales.interested,
      notInterested: r.lead_sales.not_interested,
      fuReq: r.lead_sales.follow_up_required,
      qualified: r.lead_sales.qualified_leads,
      rate: r.lead_sales.rate_provided,
      closed: r.lead_sales.closed_order_received,
      value: r.lead_sales.estimated_sales_value,
      nextFu: r.next_follow_up.total_follow_up_calls,
    });
  }
  summary.getRow(1).font = { bold: true };

  const remarksSheet = wb.addWorksheet('Key_Remarks');
  remarksSheet.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Employee', key: 'employee', width: 22 },
    { header: 'Lead Code', key: 'code', width: 12 },
    { header: 'Company', key: 'company', width: 28 },
    { header: 'Remarks', key: 'remarks', width: 50 },
  ];
  for (const r of reports) {
    for (const note of r.key_remarks) {
      remarksSheet.addRow({
        date: r.date_display,
        employee: r.employee.name,
        code: note.lead_code || '',
        company: note.company_name,
        remarks: note.remarks,
      });
    }
  }
  remarksSheet.getRow(1).font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
