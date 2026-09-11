import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

/** Project root (`src/` or `dist/` is two levels below this file). Independent of process.cwd(). */
function projectRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

export function recordingsBaseDir(): string {
  return path.join(projectRoot(), 'uploads', 'recordings');
}

function normalizeKey(relativeKey: string): string {
  return relativeKey.replace(/^[/\\]+/, '').replace(/\\/g, '/');
}

/** Paths where a recording may live (stable project dir first, then legacy cwd). */
export function localRecordingCandidates(relativeKey: string): string[] {
  const safe = normalizeKey(relativeKey);
  const unique = new Set<string>();
  const add = (p: string) => unique.add(path.normalize(p));

  // Primary + legacy cwd layouts
  add(path.join(recordingsBaseDir(), safe));
  add(path.join(process.cwd(), 'uploads', 'recordings', safe));
  add(path.join(process.cwd(), 'uploads', safe));

  // Production keys sometimes use a `lead-desk/` prefix (or nest under it).
  if (safe.startsWith('lead-desk/')) {
    const stripped = safe.replace(/^lead-desk\//, '');
    add(path.join(recordingsBaseDir(), stripped));
    add(path.join(process.cwd(), 'uploads', 'recordings', stripped));
    add(path.join(process.cwd(), 'uploads', stripped));
  } else {
    add(path.join(recordingsBaseDir(), 'lead-desk', safe));
    add(path.join(process.cwd(), 'uploads', 'recordings', 'lead-desk', safe));
    add(path.join(process.cwd(), 'uploads', 'lead-desk', safe));
  }

  // Double `recordings/recordings/` from older key builders
  if (safe.startsWith('recordings/')) {
    add(path.join(projectRoot(), 'uploads', safe));
  }

  return [...unique];
}

/** Saves a recording to local disk when S3 is not configured. */
export async function saveLocalRecording(relativeKey: string, body: Buffer): Promise<string> {
  const fullPath = path.join(recordingsBaseDir(), normalizeKey(relativeKey));
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, body);
  // Ensure bytes are durable before we return recording_id to clients.
  try {
    const fh = await fs.open(fullPath, 'r+');
    await fh.sync();
    await fh.close();
  } catch {
    // sync may be unsupported on some FS; existence check below still applies.
  }
  if (!existsSync(fullPath) || body.length === 0) {
    throw new Error(`Recording write failed for ${fullPath} (bytes=${body.length})`);
  }
  // eslint-disable-next-line no-console
  console.log(`[localRecordingStore] wrote ${body.length} bytes → ${fullPath}`);
  return relativeKey;
}

export function resolveLocalRecordingPath(relativeKey: string): string {
  return path.join(recordingsBaseDir(), normalizeKey(relativeKey));
}

export function localRecordingExists(relativeKey: string): boolean {
  if (!relativeKey || !normalizeKey(relativeKey)) return false;
  return resolveExistingLocalRecordingPath(relativeKey) != null;
}

export function resolveExistingLocalRecordingPath(relativeKey: string): string | null {
  for (const candidate of localRecordingCandidates(relativeKey)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
