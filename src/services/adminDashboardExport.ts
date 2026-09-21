import ExcelJS from 'exceljs';

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

/** Multi-user company dashboard workbook for admin download. */
export async function buildAdminDashboardWorkbook(payload: DashboardExportPayload): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lead Desk';
  wb.created = new Date();

  const range = payload.range ?? {};
  const summary = payload.summary ?? {};

  const summarySheet = wb.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Metric', key: 'metric', width: 36 },
    { header: 'Value', key: 'value', width: 24 },
  ];
  const summaryRows: Array<[string, string | number]> = [
    ['Range from', range.from ?? ''],
    ['Range to', range.to ?? ''],
    ['Days', range.days ?? ''],
    ['Total leads', summary.total_leads ?? 0],
    ['Total telecallers', summary.total_telecallers ?? 0],
    ['Calls today', summary.calls_today ?? 0],
    ['Calls in range', summary.calls_last_7_days ?? 0],
    ['Talk today', formatTalkCell(summary.talk_seconds_today)],
    ['Talk in range', formatTalkCell(summary.talk_seconds_last_7_days)],
    ['Talk today (seconds)', summary.talk_seconds_today ?? 0],
    ['Talk in range (seconds)', summary.talk_seconds_last_7_days ?? 0],
    ['Pending leads', summary.pending_leads ?? 0],
    ['Connected calls in range', summary.connected_calls_in_range ?? 0],
    ['Recordings uploaded in range', summary.recordings_uploaded_in_range ?? 0],
    ['Recording coverage %', summary.recording_coverage_percent ?? 0],
    ['Idle telecallers today', summary.idle_telecallers_today ?? 0],
    ['Overdue follow-ups', summary.overdue_followups ?? 0],
    ['Due today follow-ups', summary.due_today_followups ?? 0],
    ['Avg form fill today (sec)', summary.avg_form_fill_seconds_today ?? 0],
    ['Avg form fill in range (sec)', summary.avg_form_fill_seconds_last_7_days ?? 0],
  ];
  for (const [metric, value] of summaryRows) {
    summarySheet.addRow({ metric, value });
  }
  summarySheet.getRow(1).font = { bold: true };

  const teleSheet = wb.addWorksheet('Telecallers');
  teleSheet.columns = [
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Team', key: 'team', width: 16 },
    { header: 'Assigned', key: 'assigned', width: 12 },
    { header: 'Pending', key: 'pending', width: 12 },
    { header: 'Calls today', key: 'callsToday', width: 12 },
    { header: 'Calls in range', key: 'callsRange', width: 14 },
    { header: 'Raw lead calls today', key: 'rawToday', width: 16 },
    { header: 'Raw lead calls in range', key: 'rawRange', width: 18 },
    { header: 'Talk today', key: 'talkToday', width: 12 },
    { header: 'Talk in range', key: 'talkRange', width: 14 },
    { header: 'Talk today (sec)', key: 'talkTodaySec', width: 14 },
    { header: 'Talk in range (sec)', key: 'talkRangeSec', width: 16 },
    { header: 'Follow-ups in range', key: 'followUps', width: 16 },
    { header: 'Idle today', key: 'idle', width: 12 },
  ];
  for (const t of payload.telecallers ?? []) {
    teleSheet.addRow({
      name: t.name ?? '',
      email: t.email ?? '',
      team: t.team_name ?? '',
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
    });
  }
  teleSheet.getRow(1).font = { bold: true };

  const board = wb.addWorksheet('Leaderboard');
  board.columns = [
    { header: 'Rank', key: 'rank', width: 8 },
    { header: 'Name', key: 'name', width: 22 },
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
  board.getRow(1).font = { bold: true };

  const byDay = wb.addWorksheet('Calls_By_Day');
  byDay.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Calls', key: 'count', width: 10 },
    { header: 'Talk', key: 'talk', width: 12 },
    { header: 'Talk (sec)', key: 'talkSec', width: 12 },
  ];
  for (const d of payload.calls_by_day ?? []) {
    byDay.addRow({
      date: d.date,
      count: d.count ?? 0,
      talk: formatTalkCell(d.talk_seconds),
      talkSec: d.talk_seconds ?? 0,
    });
  }
  byDay.getRow(1).font = { bold: true };

  const outcomes = wb.addWorksheet('Outcomes');
  outcomes.columns = [
    { header: 'Outcome', key: 'outcome', width: 24 },
    { header: 'Count', key: 'count', width: 10 },
  ];
  for (const o of payload.call_outcomes ?? []) {
    outcomes.addRow({ outcome: o.outcome, count: o.count });
  }
  outcomes.getRow(1).font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
