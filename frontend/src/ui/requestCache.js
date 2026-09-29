// Short-lived cache for GET requests shared by both portal API clients.
// - Identical requests in flight at the same time share one network call.
// - A completed response is reused for a few seconds, so moving between pages
//   (dashboard → list → dashboard) shows data immediately.
// - Any write clears the whole cache, so the next read after a change is fresh.
// - Each caller gets its own copy, so one page can't mutate another's data.
const TTL_MS = 15000;
const cache = new Map();

export function cachedGet(key, fetcher, { ttl = TTL_MS } = {}) {
  const hit = cache.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < ttl)) return hit.promise.then(value => structuredClone(value));
  const promise = fetcher().then(
    value => { cache.set(key, { promise, pending: false, at: Date.now() }); return value; },
    error => { cache.delete(key); throw error; },
  );
  cache.set(key, { promise, pending: true, at: Date.now() });
  return promise.then(value => structuredClone(value));
}

export function clearRequestCache() {
  cache.clear();
}

// Live data (notification polling, unread badges), sign-in and the AI
// assistant always go to the network.
export const isCacheablePath = path => !/notifications|\/auth\/|\/ai\/|ai-support|\/health/.test(path);
