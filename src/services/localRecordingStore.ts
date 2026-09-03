import fs from 'fs/promises';
import path from 'path';

const BASE_DIR = path.join(process.cwd(), 'uploads', 'recordings');

/** Saves a recording to local disk when S3 is not configured (dev / LAN). */
export async function saveLocalRecording(relativeKey: string, body: Buffer): Promise<string> {
  const fullPath = path.join(BASE_DIR, relativeKey);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, body);
  return relativeKey;
}

export function resolveLocalRecordingPath(relativeKey: string): string {
  return path.join(BASE_DIR, relativeKey);
}
