import { env } from '../config/env';
import { getPresignedUrl } from '../config/s3';
import { localRecordingExists } from '../services/localRecordingStore';

type RecordingLike = {
  _id: { toString(): string };
  uploadStatus?: string;
  s3Bucket?: string;
  s3Key?: string;
};

/** Public playback URL, or null when the audio file is not actually stored. */
export async function publicRecordingUrl(recording: RecordingLike): Promise<string | null> {
  if (recording.uploadStatus !== 'uploaded') return null;
  const key = recording.s3Key;
  if (!key) return null;

  if (env.S3_ENABLED && recording.s3Bucket && recording.s3Bucket !== 'local') {
    const presigned = await getPresignedUrl(key);
    return presigned.url;
  }

  if (!localRecordingExists(key)) return null;
  return `recordings/${recording._id.toString()}/file`;
}
