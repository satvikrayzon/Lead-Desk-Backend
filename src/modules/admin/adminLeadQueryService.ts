import { Types } from 'mongoose';
import { env } from '../../config/env';
import { getPresignedUrl } from '../../config/s3';
import { CallRecording, Lead, LeadAssignment, User } from '../../models';
import { ILead } from '../../models/Lead';
import { formatLead, LeadResponse } from '../../utils/helpers';
import { ensureAssignmentListBackfill } from '../../services/assignmentListSync';

type AssignmentPageRow = {
  leadId: Types.ObjectId;
  agentId: Types.ObjectId;
  assignedAt: Date;
};

type HydratedAssignment = { row: AssignmentPageRow; lead: ILead };

function normalizeId(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && '_id' in value) {
    return String((value as { _id: unknown })._id);
  }
  return String(value);
}

async function loadHydratedAssignmentPage(input: {
  match: Record<string, unknown>;
  tab: 'remaining' | 'called';
  skip: number;
  limit: number;
}): Promise<HydratedAssignment[]> {
  const { match, tab, skip, limit } = input;
  const out: HydratedAssignment[] = [];
  let hydratedSeen = 0;
  let offset = 0;
  let useSort = true;
  const batchSize = Math.max(limit * 2, 80);
  const maxScan = skip + limit + 2500;

  while (out.length < limit && offset < maxScan) {
    const query = LeadAssignment.find(match).select('leadId agentId assignedAt');
    if (useSort) {
      if (tab === 'called') query.sort({ lastCalledAt: -1, _id: -1 });
      else query.sort({ importRowNumber: 1, assignedAt: 1, _id: 1 });
    }
    const batch = await query.skip(offset).limit(batchSize).lean<AssignmentPageRow[]>();
    if (batch.length === 0) {
      if (useSort && offset === 0) {
        useSort = false;
        continue;
      }
      break;
    }
    offset += batch.length;

    const ids = batch.map((row) => row.leadId).filter((id) => id != null);
    const leads =
      ids.length === 0 ? ([] as ILead[]) : await Lead.find({ _id: { $in: ids } }).lean<ILead[]>();
    const byId = new Map(leads.map((lead) => [normalizeId(lead._id), lead]));

    for (const row of batch) {
      const lead = byId.get(normalizeId(row.leadId));
      if (!lead) continue;
      if (hydratedSeen < skip) {
        hydratedSeen += 1;
        continue;
      }
      out.push({ row, lead });
      if (out.length >= limit) break;
    }
  }

  return out;
}

type AdminLeadListItem = LeadResponse & {
  latest_call?: {
    id: string;
    lead_id: string;
    phone_number: string;
    call_start_time: string;
    call_end_time: string;
    duration_seconds: number;
    recording_url: string;
    recording_id: string;
    has_recording: boolean;
  };
};

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyLeadFilters(match: Record<string, unknown>, query: Record<string, unknown>): void {
  if (typeof query.state === 'string' && query.state.trim()) match.state = query.state.trim();
  if (typeof query.district === 'string' && query.district.trim()) match.district = query.district.trim();
  if (typeof query.lead_status === 'string' && query.lead_status.trim()) {
    match.leadStatus = query.lead_status.trim();
  }
  if (typeof query.lead_stage === 'string' && query.lead_stage.trim()) {
    match.leadStage = query.lead_stage.trim();
  }
  if (typeof query.priority === 'string' && query.priority.trim()) match.priority = query.priority.trim();
  if (typeof query.customer_type === 'string' && query.customer_type.trim()) {
    match.customerType = query.customer_type.trim();
  }

  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    match.$or = [
      { companyName: rx },
      { contactPerson: rx },
      { contactMobile: rx },
      { leadCode: rx },
      { state: rx },
      { district: rx },
      { city: rx },
    ];
  }
}

async function playUrlForRecording(rec: {
  recId: Types.ObjectId;
  uploadStatus?: string;
  s3Key?: string;
  s3Bucket?: string;
}): Promise<string | null> {
  if (rec.uploadStatus !== 'uploaded' || !rec.s3Key) return null;
  if (env.S3_ENABLED && rec.s3Bucket && rec.s3Bucket !== 'local') {
    const presigned = await getPresignedUrl(rec.s3Key);
    return presigned.url;
  }
  return `recordings/${rec.recId.toString()}/file`;
}

async function attachLatestRecordings(
  formatted: AdminLeadListItem[],
  pageKeys: AssignmentPageRow[]
): Promise<AdminLeadListItem[]> {
  const leadIds = pageKeys.map((r) => r.leadId);
  if (leadIds.length === 0) return formatted;
  const recs = await CallRecording.aggregate<{
    _id: Types.ObjectId;
    recId: Types.ObjectId;
    phoneNumber: string;
    callStartTime: Date;
    callEndTime?: Date;
    durationSeconds?: number;
    uploadStatus?: string;
    s3Key?: string;
    s3Bucket?: string;
  }>([
    { $match: { leadId: { $in: leadIds }, uploadStatus: 'uploaded' } },
    { $sort: { callStartTime: -1 } },
    {
      $group: {
        _id: '$leadId',
        recId: { $first: '$_id' },
        phoneNumber: { $first: '$phoneNumber' },
        callStartTime: { $first: '$callStartTime' },
        callEndTime: { $first: '$callEndTime' },
        durationSeconds: { $first: '$durationSeconds' },
        uploadStatus: { $first: '$uploadStatus' },
        s3Key: { $first: '$s3Key' },
        s3Bucket: { $first: '$s3Bucket' },
      },
    },
  ]);

  const firstByLead = new Map(recs.map((rec) => [String(rec._id), rec]));

  return Promise.all(
    formatted.map(async (row) => {
      const rec = firstByLead.get(row.id);
      if (!rec) return row;
      const recordingUrl = await playUrlForRecording(rec);
      if (!recordingUrl) return row;
      return {
        ...row,
        latest_call: {
          id: rec.recId.toString(),
          lead_id: row.id,
          phone_number: rec.phoneNumber,
          call_start_time: rec.callStartTime.toISOString(),
          call_end_time: (rec.callEndTime ?? rec.callStartTime).toISOString(),
          duration_seconds: rec.durationSeconds ?? 0,
          recording_url: recordingUrl,
          recording_id: rec.recId.toString(),
          has_recording: true,
        },
      };
    })
  );
}

async function resolveAssignmentScope(query: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const assignmentMatch: Record<string, unknown> = { isActive: true };
  const salesExecutiveId =
    typeof query.sales_executive_id === 'string' ? query.sales_executive_id.trim() : '';
  if (salesExecutiveId && Types.ObjectId.isValid(salesExecutiveId)) {
    assignmentMatch.agentId = new Types.ObjectId(salesExecutiveId);
  }

  const teamId = typeof query.team_id === 'string' ? query.team_id.trim() : '';
  if (teamId && Types.ObjectId.isValid(teamId)) {
    const agents = await User.find({
      teamId: new Types.ObjectId(teamId),
      isActive: true,
      role: { $in: ['agent', 'manager'] },
    })
      .select('_id')
      .lean();
    const teamAgentIds = agents.map((a) => a._id as Types.ObjectId);
    if (teamAgentIds.length === 0) return null;
    if (assignmentMatch.agentId) {
      const only = assignmentMatch.agentId as Types.ObjectId;
      if (!teamAgentIds.some((id) => id.equals(only))) return null;
    } else {
      assignmentMatch.agentId = { $in: teamAgentIds };
    }
  }
  return assignmentMatch;
}

export async function queryAdminLeadsPage(input: {
  query: Record<string, unknown>;
  page: number;
  limit: number;
  includeCounts?: boolean;
}): Promise<{
  data: AdminLeadListItem[];
  meta: {
    total: number;
    page: number;
    total_pages: number;
    remaining_count?: number;
    called_count?: number;
    tab: 'remaining' | 'called';
  };
}> {
  const { query, page, limit } = input;
  const includeCounts = input.includeCounts !== false;
  const skip = (page - 1) * limit;
  const tab = query.tab === 'called' ? 'called' : 'remaining';

  void ensureAssignmentListBackfill().catch(() => undefined);

  const scope = await resolveAssignmentScope(query);
  if (!scope) {
    return {
      data: [],
      meta: {
        total: 0,
        page,
        total_pages: 1,
        remaining_count: includeCounts ? 0 : undefined,
        called_count: includeCounts ? 0 : undefined,
        tab,
      },
    };
  }

  const filters: Record<string, unknown> = { ...scope };
  applyLeadFilters(filters, query);

  const remainingMatch = { ...filters, $nor: [{ callCount: { $gt: 0 } }] };
  const calledMatch = { ...filters, callCount: { $gt: 0 } };
  const tabMatch = tab === 'called' ? calledMatch : remainingMatch;

  const [hydrated, total, remainingCount, calledCount] = await Promise.all([
    loadHydratedAssignmentPage({ match: tabMatch, tab, skip, limit }),
    LeadAssignment.countDocuments(tabMatch),
    includeCounts ? LeadAssignment.countDocuments(remainingMatch) : Promise.resolve(0),
    includeCounts ? LeadAssignment.countDocuments(calledMatch) : Promise.resolve(0),
  ]);

  const pageRows = hydrated.map((item) => item.row);
  const agentIds = [...new Set(pageRows.map((r) => normalizeId(r.agentId)))]
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  const agents =
    agentIds.length === 0
      ? []
      : await User.find({ _id: { $in: agentIds } }).select('name email teamName').lean();
  const agentById = new Map(agents.map((a) => [normalizeId(a._id), a]));

  let data = hydrated
    .map(({ row, lead }) => {
      const agent = agentById.get(normalizeId(row.agentId));
      const formatted = formatLead(lead as ILead, row.assignedAt, agent as never);
      if (!formatted.sales_executive && agent?.name) formatted.sales_executive = agent.name;
      return formatted;
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  if (tab === 'called' && data.length > 0) {
    data = await attachLatestRecordings(data, pageRows);
  }

  return {
    data,
    meta: {
      total,
      page,
      total_pages: Math.max(1, Math.ceil(total / Math.max(1, limit))),
      tab,
      remaining_count: includeCounts ? remainingCount : undefined,
      called_count: includeCounts ? calledCount : undefined,
    },
  };
}
