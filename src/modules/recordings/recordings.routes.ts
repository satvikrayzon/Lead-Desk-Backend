import { Router, Response, NextFunction } from 'express';
import { createReadStream, statSync } from 'fs';
import { CallRecording, Lead } from '../../models';
import { linkFollowUpsToRecording } from '../../utils/linkFollowUpRecording';
import { env } from '../../config/env';
import { uploadToS3, deleteFromS3, getPresignedUrl } from '../../config/s3';
import { AuthRequest } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import { uploadRecording } from '../../middleware/upload';
import {
  isLeadAssignedToAgent,
  buildRecordingS3Key,
  createAuditLog,
  isDuplicateKeyError,
} from '../../utils/helpers';
import { saveLocalRecording, resolveExistingLocalRecordingPath, localRecordingExists } from '../../services/localRecordingStore';
import { parseClientDateTime } from '../../utils/istCalendar';
import { RecordingSource } from '../../types/enums';
import { notifyRecordingReady } from '../../services/realtimeNotify';

export const recordingsRouter = Router();
recordingsRouter.post(
  '/',
  uploadRecording.single('recording'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    let uploadedS3Key: string | null = null;

    try {
      const userId = req.user!.id;

      if (!req.file) {
        throw new AppError(400, 'Recording file is required.');
      }

      const { lead_id, phone_number, call_start_time, call_end_time, duration_seconds, source, client_call_id, call_outcome } =
        req.body;

      const missingFields = [
        !lead_id && 'lead_id',
        !phone_number && 'phone_number',
        !call_start_time && 'call_start_time',
        !call_end_time && 'call_end_time',
        duration_seconds === undefined || duration_seconds === null || duration_seconds === ''
          ? 'duration_seconds'
          : null,
        !source && 'source',
      ].filter(Boolean) as string[];

      if (missingFields.length > 0) {
        throw new AppError(400, `Missing required fields: ${missingFields.join(', ')}.`);
      }

      if (!['miuiNative', 'fallback'].includes(source)) {
        throw new AppError(400, `Invalid source value "${source}". Expected miuiNative or fallback.`);
      }

      const callStartTime = parseClientDateTime(String(call_start_time));
      const callEndTime = parseClientDateTime(String(call_end_time));
      let durationSeconds = parseInt(String(duration_seconds), 10);

      if (isNaN(callStartTime.getTime()) || isNaN(callEndTime.getTime())) {
        throw new AppError(400, 'Invalid date format for call times.');
      }

      if (isNaN(durationSeconds) || durationSeconds < 1) {
        durationSeconds = Math.max(
          1,
          Math.round((callEndTime.getTime() - callStartTime.getTime()) / 1000)
        );
      }

      const lead = await Lead.findById(lead_id);
      if (!lead) {
        throw new AppError(404, 'Lead not found.');
      }

      const assigned = await isLeadAssignedToAgent(lead_id, userId);
      if (!assigned) {
        throw new AppError(403, 'You do not have access to this lead.');
      }

      const existing =
        (client_call_id
          ? await CallRecording.findOne({ agentId: userId, clientCallId: client_call_id })
          : null) ||
        (await CallRecording.findOne({
          agentId: userId,
          leadId: lead_id,
          callStartTime,
          phoneNumber: phone_number,
        }));

      const ext = req.file.originalname?.split('.').pop() || 'm4a';
      const s3Key = existing?.s3Key || buildRecordingS3Key({
        agentId: userId,
        leadId: lead_id,
        phoneNumber: phone_number,
        callStartTime,
        extension: ext,
      });

      uploadedS3Key = s3Key;

      const storageBucket = env.S3_ENABLED ? env.S3_BUCKET_NAME : 'local';

      try {
        if (env.S3_ENABLED) {
          await uploadToS3({
            key: s3Key,
            body: req.file.buffer,
            contentType: req.file.mimetype,
            contentLength: req.file.size,
          });
        } else {
          await saveLocalRecording(s3Key, req.file.buffer);
          if (!resolveExistingLocalRecordingPath(s3Key)) {
            throw new Error(`File missing after write key=${s3Key}`);
          }
        }
      } catch (storeErr) {
        // eslint-disable-next-line no-console
        console.error('[recordings] store failed', storeErr);
        throw new AppError(500, 'Failed to store recording.');
      }

      if (existing) {
        existing.s3Key = s3Key;
        existing.s3Bucket = storageBucket;
        existing.fileSizeBytes = req.file.size;
        existing.mimeType = req.file.mimetype;
        existing.originalFilename = req.file.originalname;
        existing.uploadStatus = 'uploaded';
        existing.durationSeconds = durationSeconds;
        existing.callEndTime = callEndTime;
        existing.source = source as RecordingSource;
        if (client_call_id && !existing.clientCallId) {
          existing.clientCallId = client_call_id;
        }
        await existing.save();
        if (client_call_id) {
          await linkFollowUpsToRecording(client_call_id, existing._id);
        }
        notifyRecordingReady({
          recordingId: existing._id.toString(),
          leadId: lead_id,
          agentId: userId,
          phoneNumber: phone_number,
          clientCallId: client_call_id || existing.clientCallId || null,
          callStartTime: callStartTime.toISOString(),
          callEndTime: callEndTime.toISOString(),
          durationSeconds,
        });
        return res.json({
          recording_id: existing._id.toString(),
          id: existing._id.toString(),
        });
      }

      let recording;
      try {
        recording = await CallRecording.create({
          leadId: lead_id,
          agentId: userId,
          phoneNumber: phone_number,
          callStartTime,
          callEndTime,
          durationSeconds,
          source: source as RecordingSource,
          s3Bucket: storageBucket,
          s3Key,
          fileSizeBytes: req.file.size,
          mimeType: req.file.mimetype,
          originalFilename: req.file.originalname,
          clientCallId: client_call_id || undefined,
          callOutcome: call_outcome === 'received' || !call_outcome ? 'received' : call_outcome,
          uploadStatus: 'uploaded',
        });
      } catch (dbErr: unknown) {
        if (uploadedS3Key && env.S3_ENABLED) {
          try {
            await deleteFromS3(uploadedS3Key);
          } catch {
            // ignore cleanup failure
          }
        }

        if (isDuplicateKeyError(dbErr)) {
          const dup = await CallRecording.findOne({
            agentId: userId,
            leadId: lead_id,
            callStartTime,
            phoneNumber: phone_number,
          });
          if (dup) {
            // File was already written above — point the existing row at it.
            // Previously we returned the old id without updating s3Key, so the
            // client showed "Uploaded" while GET /file 404'd.
            dup.s3Key = s3Key;
            dup.s3Bucket = storageBucket;
            dup.fileSizeBytes = req.file.size;
            dup.mimeType = req.file.mimetype;
            dup.originalFilename = req.file.originalname;
            dup.uploadStatus = 'uploaded';
            dup.durationSeconds = durationSeconds;
            dup.callEndTime = callEndTime;
            dup.source = source as RecordingSource;
            if (client_call_id) dup.clientCallId = client_call_id;
            await dup.save();
            if (client_call_id) {
              await linkFollowUpsToRecording(client_call_id, dup._id);
            }
            notifyRecordingReady({
              recordingId: dup._id.toString(),
              leadId: lead_id,
              agentId: userId,
              phoneNumber: phone_number,
              clientCallId: client_call_id || dup.clientCallId || null,
              callStartTime: callStartTime.toISOString(),
              callEndTime: (dup.callEndTime || callEndTime).toISOString(),
              durationSeconds: dup.durationSeconds ?? durationSeconds,
            });
            return res.json({
              recording_id: dup._id.toString(),
              id: dup._id.toString(),
            });
          }
        }

        throw new AppError(500, 'Failed to store recording.');
      }

      // Bump lead call stats for the Called tab (don't double-count if follow-up already did).
      const leadForStats = await Lead.findById(lead_id).select('callCount');
      const recordingCount = await CallRecording.countDocuments({ leadId: lead_id });
      await Lead.findByIdAndUpdate(lead_id, {
        $set: {
          callCount: Math.max(leadForStats?.callCount ?? 0, recordingCount),
          lastCalledAt: callEndTime,
        },
      });

      if (client_call_id) {
        await linkFollowUpsToRecording(client_call_id, recording._id);
      }

      await createAuditLog({
        userId,
        action: 'recording.uploaded',
        entityType: 'recording',
        entityId: recording._id.toString(),
        metadata: {
          leadId: lead_id,
          phoneNumber: phone_number,
          durationSeconds,
          source,
          fileSizeBytes: req.file.size,
        },
        ipAddress: req.ip,
      });

      notifyRecordingReady({
        recordingId: recording._id.toString(),
        leadId: lead_id,
        agentId: userId,
        phoneNumber: phone_number,
        clientCallId: client_call_id || null,
        callStartTime: callStartTime.toISOString(),
        callEndTime: callEndTime.toISOString(),
        durationSeconds,
      });

      res.json({
        recording_id: recording._id.toString(),
        id: recording._id.toString(),
      });
    } catch (err) {
      if (uploadedS3Key && env.S3_ENABLED && err instanceof AppError && err.statusCode === 500) {
        try {
          await deleteFromS3(uploadedS3Key);
        } catch {
          // ignore cleanup failure
        }
      }
      next(err);
    }
  }
);

/** Stream a recording file (local disk or redirect to S3). */
recordingsRouter.get('/:recordingId/file', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const userRole = req.user!.role;
    const recordingId = req.params.recordingId as string;

    const recording = await CallRecording.findById(recordingId);
    if (!recording) throw new AppError(404, 'Recording not found.');
    if (userRole === 'agent' && recording.agentId.toString() !== userId) {
      throw new AppError(403, 'You do not have access to this recording.');
    }
    if (recording.uploadStatus !== 'uploaded') {
      throw new AppError(404, 'Recording not available yet (still uploading).');
    }

    // Object lives in S3 / object storage — redirect to a fresh signed URL.
    if (env.S3_ENABLED && recording.s3Bucket !== 'local') {
      const { url } = await getPresignedUrl(recording.s3Key);
      return res.redirect(302, url);
    }

    const filePath = resolveExistingLocalRecordingPath(recording.s3Key);
    if (!filePath) {
      throw new AppError(
        404,
        'Recording file missing on server. It may have been deleted or never saved to disk.'
      );
    }

    const size = statSync(filePath).size;
    const contentType = recording.mimeType || 'audio/mp4';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=60');

    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? parseInt(match[2], 10) : Math.max(size - 1, 0);
        if (start >= size) {
          res.status(416).setHeader('Content-Range', `bytes */${size}`);
          return res.end();
        }
        const safeEnd = Math.min(end, size - 1);
        const chunk = safeEnd - start + 1;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${safeEnd}/${size}`);
        res.setHeader('Content-Length', chunk);
        createReadStream(filePath, { start, end: safeEnd }).pipe(res);
        return;
      }
    }

    res.setHeader('Content-Length', size);
    createReadStream(filePath).pipe(res);
  } catch (err) {
    next(err);
  }
});

recordingsRouter.get('/:recordingId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const userRole = req.user!.role;
    const recordingId = req.params.recordingId as string;

    const recording = await CallRecording.findById(recordingId);

    if (!recording) {
      throw new AppError(404, 'Recording not found.');
    }

    if (userRole === 'agent' && recording.agentId.toString() !== userId) {
      throw new AppError(403, 'You do not have access to this recording.');
    }

    if (recording.uploadStatus !== 'uploaded') {
      throw new AppError(404, 'Recording not available.');
    }

    if (!env.S3_ENABLED || recording.s3Bucket === 'local') {
      if (!localRecordingExists(recording.s3Key)) {
        throw new AppError(
          404,
          'Recording file missing on server. It may have been deleted or never saved to disk.'
        );
      }
      return res.json({
        url: `recordings/${recordingId}/file`,
        expires_at: null,
      });
    }

    const { url, expiresAt } = await getPresignedUrl(recording.s3Key);

    res.json({ url, expires_at: expiresAt });
  } catch (err) {
    next(err);
  }
});
