// Fixed-window, in-memory request limiter for public endpoints such as sign-up.
// Counts are per process, which is enough to slow down scripted abuse of a single
// API instance. Behind a proxy set TRUST_PROXY so req.ip is the client, not the proxy.
export function createRateLimiter({ windowMs, max, key = req => req.ip, now = () => Date.now(), message = 'Too many requests. Please try again later.' }) {
  const hits = new Map();
  function limited(id) {
    const time = now();
    if (hits.size > 10_000) for (const [entry, value] of hits) if (value.resetAt <= time) hits.delete(entry);
    const current = hits.get(id);
    if (!current || current.resetAt <= time) { hits.set(id, { count: 1, resetAt: time + windowMs }); return 0; }
    current.count += 1;
    return current.count > max ? Math.ceil((current.resetAt - time) / 1000) : 0;
  }
  return (req, res, next) => {
    const id = key(req);
    const retryAfter = id ? limited(id) : 0;
    if (!retryAfter) return next();
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ message });
  };
}
