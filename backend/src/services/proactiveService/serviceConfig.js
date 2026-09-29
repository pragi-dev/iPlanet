// Proactive-service thresholds. Every component reads them from here (and the
// API returns them) so no page hardcodes its own window.
function positiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

export function loadProactiveConfig(env = process.env) {
  return {
    // Days before the recommended date that a device becomes "Upcoming".
    upcomingDays: positiveInt(env.SERVICE_UPCOMING_DAYS, 30, 365),
    // Days after the recommended date that a "Due" device becomes "Overdue".
    overdueGraceDays: positiveInt(env.SERVICE_OVERDUE_GRACE_DAYS, 14, 365),
    // Interval used when a device has no serviceIntervalMonths of its own.
    defaultIntervalMonths: positiveInt(env.SERVICE_DEFAULT_INTERVAL_MONTHS, 6, 60),
    // Calendar days are counted in this time zone.
    timeZone: env.SERVICE_TIME_ZONE || 'Asia/Kolkata',
    // In-process scheduler cadence; 0 disables it (use the cron endpoint instead).
    schedulerMinutes: env.PROACTIVE_SERVICE_SCHEDULER_MINUTES === '0' ? 0 : positiveInt(env.PROACTIVE_SERVICE_SCHEDULER_MINUTES, 60, 1440),
    // Shared secret for the external cron endpoint; unset disables the endpoint.
    cronSecret: env.PROACTIVE_SERVICE_CRON_SECRET || '',
  };
}

export const proactiveConfig = loadProactiveConfig();
