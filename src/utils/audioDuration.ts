import fs from 'fs';
import { resolveExistingLocalRecordingPath } from '../services/localRecordingStore';

/**
 * Decode duration (seconds) from a local call recording.
 * Supports AMR-NB / AMR-WB via frame count; other formats return null here
 * (clients already send CallLog / MediaMetadata duration on upload).
 */
export function durationSecondsFromLocalFile(absolutePath: string): number | null {
  try {
    if (!absolutePath || !fs.existsSync(absolutePath)) return null;
    const buf = fs.readFileSync(absolutePath);
    if (buf.length < 16) return null;
    return durationSecondsFromAmrBuffer(buf);
  } catch {
    return null;
  }
}

export function durationSecondsFromAmrBuffer(buf: Buffer): number | null {
  const head = buf.subarray(0, 9).toString('ascii');
  const wide = head.startsWith('#!AMR-WB');
  const narrow = head.startsWith('#!AMR\n') || head.startsWith('#!AMR\r');
  if (!wide && !narrow) return null;

  const headerLen = wide ? 9 : 6;
  const frameSizes = wide ? AMR_WB_FRAME_SIZES : AMR_NB_FRAME_SIZES;
  let offset = headerLen;
  let frames = 0;

  while (offset < buf.length) {
    const toc = buf[offset];
    const ft = (toc >> 3) & 0x0f;
    const body = frameSizes[ft];
    if (body == null || body <= 0) break;
    if (offset + body > buf.length) break;
    offset += body;
    frames += 1;
    if (frames > 3_600_000) break;
  }

  if (frames <= 0) return null;
  return Math.max(1, Math.round((frames * 20) / 1000));
}

/** Prefer stored duration; if local AMR is longer / stored is empty, use file. */
export function effectiveRecordingTalkSeconds(rec: {
  durationSeconds?: number | null;
  s3Key?: string | null;
  s3Bucket?: string | null;
  _id?: { toString(): string };
}): number {
  const stored = Math.max(0, rec.durationSeconds || 0);
  const key = rec.s3Key || '';
  const isLocal = !key || rec.s3Bucket === 'local' || !rec.s3Bucket;
  if (!isLocal || !key) return stored;

  const abs = resolveExistingLocalRecordingPath(key);
  if (!abs) return stored;

  const fromFile = durationSecondsFromLocalFile(abs);
  if (fromFile == null || fromFile <= 0) return stored;
  // Trust file when DB is missing/placeholder or clearly shorter than the audio.
  if (stored <= 1 || fromFile > stored + 2) return fromFile;
  return stored;
}

const AMR_NB_FRAME_SIZES = [
  13, 14, 16, 18, 20, 21, 27, 32, 6, 7, 6, 6, 1, 1, 1, 1,
];

const AMR_WB_FRAME_SIZES = [
  18, 24, 33, 37, 41, 47, 51, 59, 61, 6, 1, 1, 1, 1, 1, 1,
];
