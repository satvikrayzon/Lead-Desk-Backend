import { Router, Response, NextFunction } from 'express';

import { Types } from 'mongoose';

import { z } from 'zod';

import { Lead, LeadAssignment, CallRecording, User } from '../../models';

import { env } from '../../config/env';

import { AuthRequest } from '../../middleware/auth';

import { AppError } from '../../middleware/errorHandler';

import { uploadExcel } from '../../middleware/upload';

import {

  formatLead,

  isLeadAssignedToAgent,

  isValidLeadStatus,

  createAuditLog,

  parseOptionalDate,

  parseOptionalNumber,

  parseOptionalString,

} from '../../utils/helpers';

import { formatImportBatch, importLeadsFromBuffer } from '../../services/excelImportService';

import { buildLeadTrackerWorkbook, loadFollowUpsByLeadId } from '../../services/excelExportService';

import { getNextLeadCode } from '../../services/leadCodeService';

import {
  filterAgentLeadAssignments,
  parseAgentLeadQuery,
} from './leadListFilters';
import { queryAgentFilterOptions, queryAgentLeadsPage } from './agentLeadQueryService';

import { LeadStatus } from '../../types/enums';

import { ILead } from '../../models/Lead';

import { isSundayIst } from '../../utils/istCalendar';



export const leadsRouter = Router();



leadsRouter.post('/import', uploadExcel.single('file'), async (req: AuthRequest, res: Response, next: NextFunction) => {

  try {
    // Large vendor sheets can take several minutes; avoid Node killing the socket early.
    req.setTimeout(15 * 60 * 1000);
    res.setTimeout(15 * 60 * 1000);

    if (!req.file) {

      throw new AppError(400, 'No file uploaded (expected multipart field "file").');

    }



    const userId = req.user!.id;
    const role = req.user!.role;
    const requestedAssignTo =
      typeof req.body?.assign_to_user_id === 'string' ? String(req.body.assign_to_user_id).trim() : '';

    let assignToUserId = userId;
    if ((role === 'admin' || role === 'manager') && requestedAssignTo) {
      if (!Types.ObjectId.isValid(requestedAssignTo)) {
        throw new AppError(400, 'Invalid assign_to_user_id.');
      }
      const target = await User.findById(requestedAssignTo);
      if (!target || !target.isActive) throw new AppError(404, 'Target telecaller not found.');
      if (!['agent', 'manager'].includes(target.role)) {
        throw new AppError(400, 'Target user must be a telecaller or team leader.');
      }
      assignToUserId = requestedAssignTo;
    }

    const batch = await importLeadsFromBuffer({

      buffer: req.file.buffer,

      originalFilename: req.file.originalname,

      uploadedByUserId: userId,

      assignToUserId,

    });



    await createAuditLog({

      userId,

      action: 'leads.imported',

      entityType: 'lead_import_batch',

      entityId: batch._id.toString(),

      metadata: {

        created_count: batch.createdCount,

        skipped_count: batch.skippedCount,

        error_count: batch.errorCount,

        assign_to_user_id: assignToUserId,

      },

      ipAddress: req.ip,

    });



    res.status(201).json({ data: formatImportBatch(batch) });

  } catch (err) {

    next(err);

  }

});



leadsRouter.get('/next-code', async (req: AuthRequest, res: Response, next: NextFunction) => {

  try {

    const userId = req.user!.id;

    const user = await User.findById(userId).select('name');

    if (!user) throw new AppError(404, 'User not found.');



    const leadCode = await getNextLeadCode(user.name, userId);

    res.json({ data: { lead_code: leadCode } });

  } catch (err) {

    next(err);

  }

});



leadsRouter.get('/filters', async (req: AuthRequest, res: Response, next: NextFunction) => {

  try {

    const userId = req.user!.id;

    res.json({ data: await queryAgentFilterOptions(userId) });

  } catch (err) {

    next(err);

  }

});



leadsRouter.get('/export', async (req: AuthRequest, res: Response, next: NextFunction) => {

  try {

    const userId = req.user!.id;

    const user = await User.findById(userId).select('name teamName');

    if (!user) throw new AppError(404, 'User not found.');



    const assignments = await LeadAssignment.find({ agentId: userId, isActive: true }).populate<{ leadId: ILead }>(

      'leadId'

    );

    const filtered = filterAgentLeadAssignments(

      assignments.map((a) => ({ leadId: a.leadId, assignedAt: a.assignedAt })),

      parseAgentLeadQuery(req.query as Record<string, unknown>)

    );

    const followUpsByLead = await loadFollowUpsByLeadId(filtered.map((a) => a.leadId._id));

    const rows = filtered.map((a) => ({

      lead: a.leadId,

      salesExecutive: user.name,

      teamLeader: user.teamName ?? '',

      followUps: followUpsByLead.get(a.leadId._id.toString()) ?? [],

    }));



    const buffer = await buildLeadTrackerWorkbook(rows);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    res.setHeader('Content-Disposition', 'attachment; filename="Sales_Lead_Tracker.xlsx"');

    res.send(buffer);

  } catch (err) {

    next(err);

  }

});



leadsRouter.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {

  try {

    const userId = req.user!.id;

    const { status, page, limit, include_counts } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const parsedLimit = parseInt(String(limit ?? ''), 10);
    const limitNum = Math.min(100, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 30));
    const listQuery = parseAgentLeadQuery(req.query as Record<string, unknown>);

    let legacyStatus: string | undefined;
    if (status && typeof status === 'string') {
      if (!isValidLeadStatus(status)) {
        throw new AppError(400, 'Invalid status value.');
      }
      legacyStatus = status;
    }

    // Page 2+ (scroll) skips badge recounts — Flutter already has remaining/called from page 1.
    const includeCounts =
      include_counts === '0' || include_counts === 'false'
        ? false
        : pageNum === 1 || include_counts === '1' || include_counts === 'true';

    const result = await queryAgentLeadsPage({
      userId,
      page: pageNum,
      limit: limitNum,
      query: listQuery,
      legacyStatus,
      includeCounts,
    });

    res.json(result);

  } catch (err) {

    next(err);

  }

});



leadsRouter.get('/:leadId', async (req: AuthRequest, res: Response, next: NextFunction) => {

  try {

    const userId = req.user!.id;

    const userRole = req.user!.role;

    const leadId = req.params.leadId as string;



    const lead = await Lead.findById(leadId);

    if (!lead) throw new AppError(404, 'Lead not found.');



    if (userRole === 'agent') {

      const assigned = await isLeadAssignedToAgent(leadId, userId);

      if (!assigned) throw new AppError(403, 'You do not have access to this lead.');

    }



    const assignment = await LeadAssignment.findOne({ leadId, isActive: true });

    const agent = assignment

      ? await User.findById(assignment.agentId).select('name email teamName')

      : await User.findById(userId).select('name email teamName');



    res.json({ data: formatLead(lead, assignment?.assignedAt ?? lead.createdAt, agent) });

  } catch (err) {

    next(err);

  }

});



const updateLeadSchema = z.object({

  status: z.string().optional(),

  notes: z.string().optional(),

  city: z.union([z.string(), z.null()]).optional(),

  contact_person: z.union([z.string(), z.null()]).optional(),

  designation: z.union([z.string(), z.null()]).optional(),

  customer_type: z.union([z.string(), z.null()]).optional(),

  customer_source: z.union([z.string(), z.null()]).optional(),

  product: z.union([z.string(), z.null()]).optional(),

  requirement_kw: z.union([z.number(), z.string(), z.null()]).optional(),

  requirement_date: z.union([z.string(), z.null()]).optional(),

  current_brand: z.union([z.string(), z.null()]).optional(),

  current_supplier: z.union([z.string(), z.null()]).optional(),

  expected_price: z.union([z.number(), z.string(), z.null()]).optional(),

  delivery_location: z.union([z.string(), z.null()]).optional(),

  lead_status: z.union([z.string(), z.null()]).optional(),

  lead_stage: z.union([z.string(), z.null()]).optional(),

  priority: z.union([z.string(), z.null()]).optional(),

  dealer_direct: z.union([z.string(), z.null()]).optional(),

  assigned_dealer: z.union([z.string(), z.null()]).optional(),

  quotation_date: z.union([z.string(), z.null()]).optional(),

  quotation_value: z.union([z.number(), z.string(), z.null()]).optional(),

  expected_order_date: z.union([z.string(), z.null()]).optional(),

  probability_percent: z.union([z.number(), z.string(), z.null()]).optional(),

  last_contact_date: z.union([z.string(), z.null()]).optional(),

  next_followup_date: z.union([z.string(), z.null()]).optional(),

  followup_remarks: z.union([z.string(), z.null()]).optional(),

  followup_2_date: z.union([z.string(), z.null()]).optional(),

  followup_2: z.union([z.string(), z.null()]).optional(),

  followup_3_date: z.union([z.string(), z.null()]).optional(),

  followup_3: z.union([z.string(), z.null()]).optional(),

  lost_reason: z.union([z.string(), z.null()]).optional(),

  order_date: z.union([z.string(), z.null()]).optional(),

  order_value: z.union([z.number(), z.string(), z.null()]).optional(),

  order_kw: z.union([z.number(), z.string(), z.null()]).optional(),

  remarks: z.union([z.string(), z.null()]).optional(),

});



function applyFollowUpFields(lead: ILead, body: z.infer<typeof updateLeadSchema>) {

  const str = (key: keyof typeof body) => parseOptionalString(body[key]);

  const num = (key: keyof typeof body) => parseOptionalNumber(body[key]);

  const date = (key: keyof typeof body) => parseOptionalDate(body[key]);



  if (body.city !== undefined) lead.city = str('city');

  if (body.contact_person !== undefined) {
    lead.contactPerson = str('contact_person');
    // Keep legacy `name` in sync for list/search fallbacks.
    if (lead.contactPerson) lead.name = lead.contactPerson;
  }

  if (body.designation !== undefined) lead.designation = str('designation');

  if (body.customer_type !== undefined) lead.customerType = str('customer_type');

  if (body.customer_source !== undefined) lead.customerSource = str('customer_source');

  if (body.product !== undefined) lead.product = str('product');

  if (body.requirement_kw !== undefined) lead.requirementKw = num('requirement_kw');

  if (body.requirement_date !== undefined) lead.requirementDate = date('requirement_date');

  if (body.current_brand !== undefined) lead.currentBrand = str('current_brand');

  if (body.current_supplier !== undefined) lead.currentSupplier = str('current_supplier');

  if (body.expected_price !== undefined) lead.expectedPrice = num('expected_price');

  if (body.delivery_location !== undefined) lead.deliveryLocation = str('delivery_location');

  if (body.lead_status !== undefined) lead.leadStatus = str('lead_status') ?? lead.leadStatus;

  if (body.lead_stage !== undefined) lead.leadStage = str('lead_stage');

  if (body.priority !== undefined) lead.priority = str('priority');

  if (body.dealer_direct !== undefined) lead.dealerDirect = str('dealer_direct');

  if (body.assigned_dealer !== undefined) lead.assignedDealer = str('assigned_dealer');

  if (body.quotation_date !== undefined) lead.quotationDate = date('quotation_date');

  if (body.quotation_value !== undefined) lead.quotationValue = num('quotation_value');

  if (body.expected_order_date !== undefined) lead.expectedOrderDate = date('expected_order_date');

  if (body.probability_percent !== undefined) lead.probabilityPercent = num('probability_percent');

  if (body.last_contact_date !== undefined) lead.lastContactDate = date('last_contact_date');

  if (body.next_followup_date !== undefined) {
    const next = date('next_followup_date');
    if (next && isSundayIst(next)) {
      throw new AppError(400, 'Follow-up cannot be set on Sunday. Please choose another day.');
    }
    lead.nextFollowupDate = next;
  }

  if (body.followup_remarks !== undefined) lead.followupRemarks = str('followup_remarks');

  if (body.followup_2_date !== undefined) lead.followup2Date = date('followup_2_date');

  if (body.followup_2 !== undefined) lead.followup2 = str('followup_2');

  if (body.followup_3_date !== undefined) lead.followup3Date = date('followup_3_date');

  if (body.followup_3 !== undefined) lead.followup3 = str('followup_3');

  if (body.lost_reason !== undefined) lead.lostReason = str('lost_reason');

  if (body.order_date !== undefined) lead.orderDate = date('order_date');

  if (body.order_value !== undefined) lead.orderValue = num('order_value');

  if (body.order_kw !== undefined) lead.orderKw = num('order_kw');

  if (body.remarks !== undefined) lead.remarks = str('remarks');

}



leadsRouter.patch('/:leadId', async (req: AuthRequest, res: Response, next: NextFunction) => {

  try {

    const userId = req.user!.id;

    const leadId = req.params.leadId as string;



    const parsed = updateLeadSchema.safeParse(req.body);

    if (!parsed.success) {

      throw new AppError(400, 'Invalid request body.');

    }



    const lead = await Lead.findById(leadId);

    if (!lead) {

      throw new AppError(404, 'Lead not found.');

    }



    const assigned = await isLeadAssignedToAgent(leadId, userId);

    if (!assigned) {

      throw new AppError(403, 'You do not have access to this lead.');

    }



    const agent = await User.findById(userId).select('name teamName');

    if (!agent) throw new AppError(404, 'User not found.');



    const { status, notes } = parsed.data;

    const isFollowUpSave = Object.keys(parsed.data).some((k) => k !== 'status' && k !== 'notes');



    if (isFollowUpSave) {

      const remarks = parsed.data.followup_remarks;

      if (remarks === undefined || remarks === null || String(remarks).trim() === '') {

        throw new AppError(400, 'Followup_Remarks is required.');

      }

    }



    if (!lead.leadCode) {

      lead.leadCode = await getNextLeadCode(agent.name, userId);

      lead.leadDate = new Date();

      lead.salesExecutive = agent.name;

      lead.teamLeader = agent.teamName ?? undefined;

      if (!lead.customerSource) lead.customerSource = 'Cold Calling';

    }



    if (status !== undefined && !isValidLeadStatus(status)) {

      throw new AppError(400, 'Invalid status value.');

    }



    if (status !== undefined) lead.status = status as LeadStatus;

    if (notes !== undefined) lead.notes = notes;



    applyFollowUpFields(lead, parsed.data);

    await lead.save();



    const assignment = await LeadAssignment.findOne({

      leadId,

      agentId: userId,

      isActive: true,

    });



    await createAuditLog({

      userId,

      action: 'lead.updated',

      entityType: 'lead',

      entityId: leadId,

      metadata: { fields: Object.keys(parsed.data) },

      ipAddress: req.ip,

    });



    res.json({ data: formatLead(lead, assignment!.assignedAt, agent) });

  } catch (err) {

    next(err);

  }

});



leadsRouter.get('/:leadId/calls', async (req: AuthRequest, res: Response, next: NextFunction) => {

  try {

    const userId = req.user!.id;

    const userRole = req.user!.role;

    const leadId = req.params.leadId as string;



    const lead = await Lead.findById(leadId);

    if (!lead) {

      throw new AppError(404, 'Lead not found.');

    }



    if (userRole === 'agent') {

      const assigned = await isLeadAssignedToAgent(leadId, userId);

      if (!assigned) {

        throw new AppError(403, 'You do not have access to this lead.');

      }

    }



    const recordings = await CallRecording.find({ leadId })

      .populate('agentId', 'name')

      .sort({ callStartTime: -1 });



    const data = await Promise.all(

      recordings.map(async (rec) => {

        let recordingUrl: string | null = null;

        if (rec.uploadStatus === 'uploaded') {
          if (env.S3_ENABLED && rec.s3Bucket !== 'local') {
            const { getPresignedUrl } = await import('../../config/s3');
            const presigned = await getPresignedUrl(rec.s3Key);
            recordingUrl = presigned.url;
          } else {
            recordingUrl = `recordings/${rec._id.toString()}/file`;
          }
        }



        const agent = rec.agentId as unknown as { _id: { toString(): string }; name: string };



        return {

          id: rec._id.toString(),

          lead_id: rec.leadId.toString(),

          agent_id: agent._id.toString(),

          agent_name: agent.name,

          phone_number: rec.phoneNumber,

          call_start_time: rec.callStartTime.toISOString(),

          call_end_time: rec.callEndTime.toISOString(),

          duration_seconds: rec.durationSeconds,

          source: rec.source,

          call_outcome: rec.callOutcome ?? 'received',

          client_call_id: rec.clientCallId ?? null,

          recording_url: recordingUrl,

          created_at: rec.createdAt.toISOString(),

        };

      })

    );



    res.json({ data });

  } catch (err) {

    next(err);

  }

});


