/** In-memory dashboard cache with stale-while-revalidate + single-flight. */

type CacheEntry = { expiresAt: number; staleUntil: number; data: unknown };

const telecallerCache = new Map<string, CacheEntry>();
const adminCache = new Map<string, CacheEntry>();
const telecallerInflight = new Map<string, Promise<unknown>>();
const adminInflight = new Map<string, Promise<unknown>>();

export const TELECALLER_DASH_CACHE_MS = 5 * 60_000;
export const ADMIN_DASH_CACHE_MS = 5 * 60_000;
const STALE_MS = 30 * 60_000;

function readHit(map: Map<string, CacheEntry>, key: string): { data: unknown; fresh: boolean } | null {
  const hit = map.get(key);
  if (!hit) return null;
  const now = Date.now();
  if (hit.expiresAt > now) return { data: hit.data, fresh: true };
  if (hit.staleUntil > now) return { data: hit.data, fresh: false };
  return null;
}

function writeHit(map: Map<string, CacheEntry>, key: string, data: unknown, ttlMs: number): void {
  const now = Date.now();
  map.set(key, { data, expiresAt: now + ttlMs, staleUntil: now + STALE_MS });
}

async function withCache(
  store: Map<string, CacheEntry>,
  inflight: Map<string, Promise<unknown>>,
  key: string,
  ttlMs: number,
  compute: () => Promise<unknown>
): Promise<unknown> {
  const hit = readHit(store, key);
  if (hit?.fresh) return hit.data;

  let pending = inflight.get(key);
  if (!pending) {
    pending = compute()
      .then((data) => {
        writeHit(store, key, data, ttlMs);
        return data;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }

  if (hit && !hit.fresh) return hit.data;
  return pending;
}

export function getTelecallerDashCache(userId: string): unknown | null {
  return readHit(telecallerCache, userId)?.data ?? null;
}

export function setTelecallerDashCache(userId: string, data: unknown): void {
  writeHit(telecallerCache, userId, data, TELECALLER_DASH_CACHE_MS);
}

export function getAdminDashCache(key: string): unknown | null {
  return readHit(adminCache, key)?.data ?? null;
}

export function setAdminDashCache(key: string, data: unknown): void {
  writeHit(adminCache, key, data, ADMIN_DASH_CACHE_MS);
}

export function withTelecallerDashCache(userId: string, compute: () => Promise<unknown>): Promise<unknown> {
  return withCache(telecallerCache, telecallerInflight, userId, TELECALLER_DASH_CACHE_MS, compute);
}

export function withAdminDashCache(key: string, compute: () => Promise<unknown>): Promise<unknown> {
  return withCache(adminCache, adminInflight, key, ADMIN_DASH_CACHE_MS, compute);
}

export function invalidateDashboards(userId?: string): void {
  if (userId) telecallerCache.delete(userId);
  else telecallerCache.clear();
  adminCache.clear();
}
