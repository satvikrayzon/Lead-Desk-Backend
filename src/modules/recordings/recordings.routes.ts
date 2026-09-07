import { Router, Response, NextFunction } from 'express';
import { createReadStream } from 'fs';
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
import { saveLocalRecording, resolveLocalRecordingPath } from '../../services/localRecordingStore';
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

      const callStartTime = new Date(call_start_time);
      const callEndTime = new Date(call_end_time);
      const durationSeconds = parseInt(duration_seconds, 10);

      if (isNaN(callStartTime.getTime()) || isNaN(callEndTime.getTime())) {
        throw new AppError(400, 'Invalid date format for call times.');
      }

      if (durationSeconds < 1) {
        throw new AppError(400, 'Recording upload requires a connected call (duration > 0).');
      }

      const lead = await Lead.findById(lead_id);
      if (!lead) {
        throw new AppError(404, 'Lead not found.');
      }

      const assigned = await isLeadAssignedToAgent(lead_id, userId);
      if (!assigned) {
        throw new AppError(403, 'You do not have access to this lead.');
      }

      const existing = await CallRecording.findOne({
        agentId: userId,
        leadId: lead_id,
        callStartTime,
        phoneNumber: phone_number,
      });

      if (existing) {
        if (client_call_id) {
          await linkFollowUpsToRecording(client_call_id, existing._id);
          if (!existing.clientCallId) {
            existing.clientCallId = client_call_id;
            await existing.save();
          }
        }
        return res.json({
          recording_id: existing._id.toString(),
          id: existing._id.toString(),
        });
      }

      const ext = req.file.originalname?.split('.').pop() || 'm4a';
      const s3Key = buildRecordingS3Key({
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
        }
      } catch {
        throw new AppError(500, 'Failed to store recording.');
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
            notifyRecordingReady({
              recordingId: dup._id.toString(),
              leadId: lead_id,
              agentId: userId,
              phoneNumber: phone_number,
              clientCallId: client_call_id || null,
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

      // Bump lead call stats for the Called tab.
      await Lead.findByIdAndUpdate(lead_id, {
        $inc: { callCount: 1 },
        $set: { lastCalledAt: callEndTime },
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

/** Stream a recording file (local disk storage — used when S3 is disabled). */
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
      throw new AppError(404, 'Recording not available.');
    }

    const filePath = resolveLocalRecordingPath(recording.s3Key);
    res.setHeader('Content-Type', recording.mimeType || 'audio/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
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
      return res.json({
        url: `${env.API_BASE_URL}/api/recordings/${recordingId}/file`,
        expires_at: null,
      });
    }

    const { url, expiresAt } = await getPresignedUrl(recording.s3Key);

    res.json({ url, expires_at: expiresAt });
  } catch (err) {
    next(err);
  }
});
