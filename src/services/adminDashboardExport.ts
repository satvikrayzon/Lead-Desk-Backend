import ExcelJS from 'exceljs';
import type { DailySalesReport } from './dailySalesReportService';

type DashboardExportPayload = {
  range?: { from?: string; to?: string; days?: number };
  summary?: Record<string, number>;
  telecallers?: Array<Record<string, unknown>>;
  leaderboard?: Array<Record<string, unknown>>;
  calls_by_day?: Array<{ date: string; count: number; talk_seconds: number }>;
  call_outcomes?: Array<{ outcome: string; count: number }>;
};

function formatTalkCell(seconds: unknown): string {
  const s = typeof seconds === 'number' ? Math.max(0, Math.round(seconds)) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true };
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE8EEF9' },
  };
}

/**
 * One Excel workbook with every telecaller as a row (user-wise).
 * Sheet 1: performance by user
 * Sheet 2: daily sales by user (when provided)
 * Sheet 3: key remarks by user
 */
export async function buildAdminDashboardWorkbook(
  payload: DashboardExportPayload,
  salesReports: DailySalesReport[] = []
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lead Desk';
  wb.created = new Date();

  const range = payload.range ?? {};
  const salesById = new Map(salesReports.map((r) => [r.employee.id, r]));

  // --- Sheet 1: one row per telecaller (main report) ---
  const users = wb.addWorksheet('All_Telecallers');
  users.columns = [
    { header: 'Telecaller', key: 'name', width: 22 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Team', key: 'team', width: 16 },
    { header: 'Report From', key: 'from', width: 12 },
    { header: 'Report To', key: 'to', width: 12 },
    { header: 'Assigned Leads', key: 'assigned', width: 14 },
    { header: 'Pending Leads', key: 'pending', width: 14 },
    { header: 'Calls Today', key: 'callsToday', width: 12 },
    { header: 'Calls In Range', key: 'callsRange', width: 14 },
    { header: 'Raw Lead Calls Today', key: 'rawToday', width: 18 },
    { header: 'Raw Lead Calls In Range', key: 'rawRange', width: 20 },
    { header: 'Talk Today', key: 'talkToday', width: 12 },
    { header: 'Talk In Range', key: 'talkRange', width: 14 },
    { header: 'Talk Today (sec)', key: 'talkTodaySec', width: 14 },
    { header: 'Talk In Range (sec)', key: 'talkRangeSec', width: 16 },
    { header: 'Follow-ups In Range', key: 'followUps', width: 16 },
    { header: 'Idle Today', key: 'idle', width: 12 },
    // Sales columns (same range) when available
    { header: 'Calls Attempted (sales)', key: 'salesAttempted', width: 18 },
    { header: 'Calls Connected', key: 'salesConnected', width: 14 },
    { header: 'No Answer', key: 'salesNoAnswer', width: 12 },
    { header: 'Busy', key: 'salesBusy', width: 10 },
    { header: 'Wrong Number', key: 'salesWrong', width: 12 },
    { header: 'Interested', key: 'interested', width: 12 },
    { header: 'Not Interested', key: 'notInterested', width: 14 },
    { header: 'Follow-up Required', key: 'fuReq', width: 16 },
    { header: 'Qualified', key: 'qualified', width: 12 },
    { header: 'Rate Provided', key: 'rate', width: 12 },
    { header: 'Closed / Order', key: 'closed', width: 14 },
    { header: 'Est. Sales Value', key: 'salesValue', width: 14 },
    { header: 'Talk (sales report)', key: 'salesTalk', width: 14 },
  ];

  const telecallers = [...(payload.telecallers ?? [])].sort((a, b) =>
    String(a.name ?? '').localeCompare(String(b.name ?? ''))
  );

  for (const t of telecallers) {
    const id = String(t.id ?? '');
    const sales = salesById.get(id);
    users.addRow({
      name: t.name ?? '',
      email: t.email ?? '',
      team: t.team_name ?? '',
      from: range.from ?? '',
      to: range.to ?? '',
      assigned: t.assigned_leads ?? 0,
      pending: t.pending_leads ?? 0,
      callsToday: t.calls_today ?? 0,
      callsRange: t.calls_last_7_days ?? 0,
      rawToday: t.calls_from_raw_leads_today ?? 0,
      rawRange: t.calls_from_raw_leads_in_range ?? 0,
      talkToday: formatTalkCell(t.talk_seconds_today),
      talkRange: formatTalkCell(t.talk_seconds_last_7_days),
      talkTodaySec: t.talk_seconds_today ?? 0,
      talkRangeSec: t.talk_seconds_last_7_days ?? 0,
      followUps: t.follow_ups_in_range ?? 0,
      idle: t.idle_today ? 'Yes' : 'No',
      salesAttempted: sales?.calling.calls_attempted ?? '',
      salesConnected: sales?.calling.calls_connected ?? '',
      salesNoAnswer: sales?.calling.no_answer ?? '',
      salesBusy: sales?.calling.busy_switched_off ?? '',
      salesWrong: sales?.calling.wrong_number ?? '',
      interested: sales?.lead_sales.interested ?? '',
      notInterested: sales?.lead_sales.not_interested ?? '',
      fuReq: sales?.lead_sales.follow_up_required ?? '',
      qualified: sales?.lead_sales.qualified_leads ?? '',
      rate: sales?.lead_sales.rate_provided ?? '',
      closed: sales?.lead_sales.closed_order_received ?? '',
      salesValue: sales?.lead_sales.estimated_sales_value ?? '',
      salesTalk: sales ? formatTalkCell(sales.talk_seconds) : '',
    });
  }
  styleHeader(users.getRow(1));
  users.views = [{ state: 'frozen', ySplit: 1 }];

  // --- Sheet 2: sales detail one row per user (if any) ---
  if (salesReports.length > 0) {
    const salesSheet = wb.addWorksheet('Sales_By_Telecaller');
    salesSheet.columns = [
      { header: 'Telecaller', key: 'employee', width: 22 },
      { header: 'Email', key: 'email', width: 28 },
      { header: 'Team', key: 'team', width: 16 },
      { header: 'Date From', key: 'from', width: 12 },
      { header: 'Date To', key: 'to', width: 12 },
      { header: 'Calls Attempted', key: 'attempted', width: 14 },
      { header: 'Raw Lead Calls', key: 'rawCalls', width: 14 },
      { header: 'Follow-up Calls', key: 'fuCalls', width: 14 },
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
      { header: 'Talk Time', key: 'talk', width: 12 },
      { header: 'Talk Seconds', key: 'talkSec', width: 12 },
      { header: 'Next Follow-ups', key: 'nextFu', width: 14 },
    ];

    const sortedSales = [...salesReports].sort((a, b) =>
      a.employee.name.localeCompare(b.employee.name)
    );
    for (const r of sortedSales) {
      salesSheet.addRow({
        employee: r.employee.name,
        email: r.employee.email || '',
        team: r.employee.team_name || '',
        from: r.date_from,
        to: r.date_to,
        attempted: r.calling.calls_attempted,
        rawCalls: r.calling.calls_from_raw_leads,
        fuCalls: r.calling.calls_from_follow_ups,
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
        talk: formatTalkCell(r.talk_seconds),
        talkSec: r.talk_seconds,
        nextFu: r.next_follow_up.total_follow_up_calls,
      });
    }
    styleHeader(salesSheet.getRow(1));
    salesSheet.views = [{ state: 'frozen', ySplit: 1 }];

    const remarksSheet = wb.addWorksheet('Remarks_By_Telecaller');
    remarksSheet.columns = [
      { header: 'Telecaller', key: 'employee', width: 22 },
      { header: 'Team', key: 'team', width: 16 },
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Lead Code', key: 'code', width: 12 },
      { header: 'Company', key: 'company', width: 28 },
      { header: 'Remarks', key: 'remarks', width: 50 },
    ];
    for (const r of sortedSales) {
      for (const note of r.key_remarks) {
        remarksSheet.addRow({
          employee: r.employee.name,
          team: r.employee.team_name || '',
          date: r.date_display,
          code: note.lead_code || '',
          company: note.company_name,
          remarks: note.remarks,
        });
      }
    }
    styleHeader(remarksSheet.getRow(1));
    remarksSheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  // --- Sheet: ranking (still user-wise) ---
  const board = wb.addWorksheet('Leaderboard');
  board.columns = [
    { header: 'Rank', key: 'rank', width: 8 },
    { header: 'Telecaller', key: 'name', width: 22 },
    { header: 'Team', key: 'team', width: 16 },
    { header: 'Calls', key: 'calls', width: 10 },
    { header: 'Talk', key: 'talk', width: 12 },
    { header: 'Talk (sec)', key: 'talkSec', width: 12 },
    { header: 'Follow-ups', key: 'followUps', width: 12 },
  ];
  for (const row of payload.leaderboard ?? []) {
    board.addRow({
      rank: row.rank ?? '',
      name: row.name ?? '',
      team: row.team_name ?? '',
      calls: row.calls ?? 0,
      talk: formatTalkCell(row.talk_seconds),
      talkSec: row.talk_seconds ?? 0,
      followUps: row.follow_ups ?? 0,
    });
  }
  styleHeader(board.getRow(1));

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
