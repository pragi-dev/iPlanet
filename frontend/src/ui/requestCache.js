// Short-lived cache for GET requests shared by both portal API clients.
// - Identical requests in flight at the same time share one network call.
// - A completed response is reused for a few seconds, so moving between pages
//   (dashboard → list → dashboard) shows data immediately.
// - Any write clears the whole cache, so the next read after a change is fresh.
// - Each caller gets its own copy, so one page can't mutate another's data.
const TTL_MS = 15000;
const cache = new Map();
// Bumped by every clear. A request that started before a write must not put its
// (pre-write) response back into the cache when it finishes afterwards.
let generation = 0;

export function cachedGet(key, fetcher, { ttl = TTL_MS } = {}) {
  const hit = cache.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < ttl)) return hit.promise.then(value => structuredClone(value));
  const startedIn = generation;
  const isCurrent = () => startedIn === generation && cache.get(key)?.promise === promise;
  const promise = fetcher().then(
    value => { if (isCurrent()) cache.set(key, { promise, pending: false, at: Date.now() }); return value; },
    error => { if (isCurrent()) cache.delete(key); throw error; },
  );
  cache.set(key, { promise, pending: true, at: Date.now() });
  return promise.then(value => structuredClone(value));
}

export function clearRequestCache() {
  generation += 1;
  cache.clear();
}

// Live data (notification polling, unread badges), sign-in and the AI
// assistant always go to the network. Google Business data has its own
// short-lived cache on the backend.
export const isCacheablePath = path => !/notifications|\/auth\/|\/ai\/|ai-support|\/health|google-business/.test(path);
