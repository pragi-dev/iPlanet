import { safeErrorMessage } from './redact.js';

// Polls the configured inboxes and works the processing queues every
// `minutes`. Set B2C_EMAIL_POLL_MINUTES=0 to disable it and call
// POST /api/internal/b2c/run from an external scheduler instead.
// Timed work (completed escalations due to close, assignment reminders due) is checked on a
// short timer of its own, so it happens on time rather than at the next poll.
const TIMED_WORK_CHECK_MS = 15_000;
const plural = (count, unit) => `${count} ${unit}${count === 1 ? '' : 's'}`;

export function createB2CScheduler({ service, minutes, logger = console }) {
  let timer = null;
  let closeTimer = null;
  const tick = () => service.runCycle('scheduled').catch(error => logger.error(`[B2C] Scheduled run failed: ${safeErrorMessage(error)}`));
  const timedTick = () => service.runTimedWork().catch(error => logger.error(`[B2C] Timed work failed: ${safeErrorMessage(error)}`));
  return {
    start() {
      if ((service.autoCloseMinutes || service.assignReminderHours || service.startReminderHours) && !closeTimer) {
        closeTimer = setInterval(timedTick, TIMED_WORK_CHECK_MS);
        closeTimer.unref?.();
        if (service.autoCloseMinutes) logger.info(`[B2C] Completed escalations close automatically ${plural(service.autoCloseMinutes, 'minute')} after completion.`);
        if (service.assignReminderHours) logger.info(`[B2C] Cluster Managers are reminded to assign an escalation still unassigned after ${plural(service.assignReminderHours, 'hour')}.`);
        if (service.startReminderHours) logger.info(`[B2C] Service Executives are reminded to accept and start an escalation not started ${plural(service.startReminderHours, 'hour')} after assignment.`);
      }
      if (!minutes || timer) return;
      timer = setInterval(tick, minutes * 60_000);
      timer.unref?.();
      setTimeout(tick, 5_000).unref?.();
      logger.info(`[B2C] Email processing runs every ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    },
    stop() { clearInterval(timer); clearInterval(closeTimer); timer = null; closeTimer = null; },
  };
}
