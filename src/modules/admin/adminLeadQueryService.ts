import { Types } from 'mongoose';
import { env } from '../../config/env';
import { getPresignedUrl } from '../../config/s3';
import { CallRecording, Lead, User } from '../../models';
import { ILead } from '../../models/Lead';
import { formatLead, LeadResponse } from '../../utils/helpers';
import { loadAssignmentIndex } from '../../services/assignmentLeadLite';

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

type TabRow = { leadId: Types.ObjectId; agentId: Types.ObjectId; assignedAt: Date };
type TabIndex = {
  expiresAt: number;
  remaining: TabRow[];
  called: TabRow[];
};

const tabIndexCache = new Map<string, TabIndex>();
const tabIndexInflight = new Map<string, Promise<TabIndex>>();
const TAB_INDEX_MS = 2 * 60_000;

function indexCacheKey(assignmentMatch: Record<string, unknown>, query: Record<string, unknown>): string {
  const agent = assignmentMatch.agentId;
  const agentKey =
    agent && typeof agent === 'object' && '$in' in (agent as object)
      ? (agent as { $in: Types.ObjectId[] }).$in.map((id) => String(id)).join(',')
      : String(agent ?? '');
  return JSON.stringify({
    agent: agentKey,
    state: query.state ?? '',
    district: query.district ?? '',
    lead_status: query.lead_status ?? '',
    lead_stage: query.lead_stage ?? '',
    priority: query.priority ?? '',
    customer_type: query.customer_type ?? '',
    search: typeof query.search === 'string' ? query.search.trim().toLowerCase() : '',
  });
}

function matchesFilters(
  lead: {
    state?: string;
    district?: string;
    leadStatus?: string;
    leadStage?: string;
    priority?: string;
    customerType?: string;
  },
  query: Record<string, unknown>
): boolean {
  if (typeof query.state === 'string' && query.state && (lead.state ?? '') !== query.state) return false;
  if (typeof query.district === 'string' && query.district && (lead.district ?? '') !== query.district) {
    return false;
  }
  if (typeof query.lead_status === 'string' && query.lead_status && (lead.leadStatus ?? '') !== query.lead_status) {
    return false;
  }
  if (typeof query.lead_stage === 'string' && query.lead_stage && (lead.leadStage ?? '') !== query.lead_stage) {
    return false;
  }
  if (typeof query.priority === 'string' && query.priority && (lead.priority ?? '') !== query.priority) {
    return false;
  }
  if (
    typeof query.customer_type === 'string' &&
    query.customer_type &&
    (lead.customerType ?? '') !== query.customer_type
  ) {
    return false;
  }
  return true;
}

function matchesSearch(
  lead: {
    name?: string;
    phoneNumber?: string;
    companyName?: string;
    company?: string;
    contactPerson?: string;
    contactMobile?: string;
    state?: string;
    district?: string;
    city?: string;
    leadCode?: string;
  },
  search?: string
): boolean {
  if (!search?.trim()) return true;
  const term = search.trim().toLowerCase();
  return [
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
  ].some((v) => (v ?? '').toLowerCase().includes(term));
}

async function loadTabIndex(
  assignmentMatch: Record<string, unknown>,
  query: Record<string, unknown>
): Promise<TabIndex> {
  const key = indexCacheKey(assignmentMatch, query);
  const hit = tabIndexCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit;
  const pending = tabIndexInflight.get(key);
  if (pending) return pending;
  const compute = loadTabIndexUncached(assignmentMatch, query, key);
  tabIndexInflight.set(key, compute);
  try {
    return await compute;
  } finally {
    tabIndexInflight.delete(key);
  }
}

async function loadTabIndexUncached(
  assignmentMatch: Record<string, unknown>,
  query: Record<string, unknown>,
  key: string
): Promise<TabIndex> {

  const assignments = await loadAssignmentIndex(assignmentMatch);
  if (assignments.length === 0) {
    const empty = { expiresAt: Date.now() + TAB_INDEX_MS, remaining: [], called: [] };
    tabIndexCache.set(key, empty);
    return empty;
  }

  const search = typeof query.search === 'string' ? query.search : '';
  const needSearch = Boolean(search.trim());
  const select = needSearch
    ? 'callCount lastCalledAt importRowNumber createdAt state district leadStatus leadStage priority customerType name phoneNumber companyName company contactPerson contactMobile city leadCode'
    : 'callCount lastCalledAt importRowNumber createdAt state district leadStatus leadStage priority customerType';

  const leads = await Lead.find({ _id: { $in: assignments.map((a) => a.leadId) } })
    .select(select)
    .lean();
  const byId = new Map(leads.map((l) => [String(l._id), l]));

  const remaining: TabRow[] = [];
  const called: TabRow[] = [];
  for (const a of assignments) {
    const lead = byId.get(String(a.leadId));
    if (!lead) continue;
    if (!matchesFilters(lead, query)) continue;
    if (!matchesSearch(lead, search)) continue;
    const row = { leadId: a.leadId, agentId: a.agentId, assignedAt: a.assignedAt };
    if ((lead.callCount ?? 0) > 0) called.push(row);
    else remaining.push(row);
  }

  remaining.sort((a, b) => {
    const la = byId.get(String(a.leadId));
    const lb = byId.get(String(b.leadId));
    const ra = la?.importRowNumber ?? 999999999;
    const rb = lb?.importRowNumber ?? 999999999;
    if (ra !== rb) return ra - rb;
    const ca = (la?.createdAt ?? a.assignedAt).getTime();
    const cb = (lb?.createdAt ?? b.assignedAt).getTime();
    return ca - cb;
  });
  called.sort((a, b) => {
    const la = byId.get(String(a.leadId))?.lastCalledAt?.getTime() ?? a.assignedAt.getTime();
    const lb = byId.get(String(b.leadId))?.lastCalledAt?.getTime() ?? b.assignedAt.getTime();
    return lb - la;
  });

  const packed = { expiresAt: Date.now() + TAB_INDEX_MS, remaining, called };
  tabIndexCache.set(key, packed);
  return packed;
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
  pageKeys: TabRow[]
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
    if (teamAgentIds.length === 0) {
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
    if (assignmentMatch.agentId) {
      const only = assignmentMatch.agentId as Types.ObjectId;
      if (!teamAgentIds.some((id) => id.equals(only))) {
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
    } else {
      assignmentMatch.agentId = { $in: teamAgentIds };
    }
  }

  const index = await loadTabIndex(assignmentMatch, query);
  const tabRows = tab === 'called' ? index.called : index.remaining;
  const total = tabRows.length;
  const pageKeys = tabRows.slice(skip, skip + limit);

  const leadIds = pageKeys.map((r) => r.leadId);
  const agentIds = [...new Set(pageKeys.map((r) => String(r.agentId)))].map((id) => new Types.ObjectId(id));
  const [leadDocs, agents] = await Promise.all([
    leadIds.length === 0 ? Promise.resolve([] as ILead[]) : Lead.find({ _id: { $in: leadIds } }).lean(),
    agentIds.length === 0
      ? Promise.resolve([])
      : User.find({ _id: { $in: agentIds } }).select('name email teamName').lean(),
  ]);
  const leadById = new Map(leadDocs.map((l) => [String(l._id), l]));
  const agentById = new Map(agents.map((a) => [String(a._id), a]));

  let data = pageKeys
    .map((row) => {
      const lead = leadById.get(String(row.leadId));
      if (!lead) return null;
      const agent = agentById.get(String(row.agentId));
      const formatted = formatLead(lead as ILead, row.assignedAt, agent as never);
      if (!formatted.sales_executive && agent?.name) formatted.sales_executive = agent.name;
      return formatted;
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  if (tab === 'called' && data.length > 0) {
    data = await attachLatestRecordings(data, pageKeys);
  }

  return {
    data,
    meta: {
      total,
      page,
      total_pages: Math.max(1, Math.ceil(total / Math.max(1, limit))),
      tab,
      remaining_count: includeCounts ? index.remaining.length : undefined,
      called_count: includeCounts ? index.called.length : undefined,
    },
  };
}
