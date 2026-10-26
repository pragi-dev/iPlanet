import cors from 'cors';

// Shared by the main API and the standalone B2C server, so both accept the same portal origins.
export function createCorsMiddleware(frontendUrls = process.env.FRONTEND_URLS || 'http://localhost:5173,http://localhost:5174') {
  const allowedOrigins = new Set(frontendUrls
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean));
  const isAllowedOrigin = origin => {
    if (!origin) return true;
    if (allowedOrigins.has(origin)) return true;
    try {
      const hostname = new URL(origin).hostname;
      return ['localhost', '127.0.0.1'].includes(hostname)
        || hostname.endsWith('.loca.lt')
        || hostname.endsWith('.localtunnel.me')
        || hostname.endsWith('.devtunnels.ms')
        || hostname.endsWith('.app.github.dev')
        || hostname.endsWith('.vercel.app');
    } catch {
      return false;
    }
  };
  return cors({
    origin(origin, callback) {
      // Requests without an Origin header include local health checks and curl.
      if (isAllowedOrigin(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
}
