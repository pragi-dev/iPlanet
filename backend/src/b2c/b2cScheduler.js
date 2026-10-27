import { safeErrorMessage } from './redact.js';

// Polls the configured inboxes and works the processing queues every
// `minutes`. Set B2C_EMAIL_POLL_MINUTES=0 to disable it and call
// POST /api/internal/b2c/run from an external scheduler instead.
export function createB2CScheduler({ service, minutes, logger = console }) {
  let timer = null;
  const tick = () => service.runCycle('scheduled').catch(error => logger.error(`[B2C] Scheduled run failed: ${safeErrorMessage(error)}`));
  return {
    start() {
      if (!minutes || timer) return;
      timer = setInterval(tick, minutes * 60_000);
      timer.unref?.();
      setTimeout(tick, 5_000).unref?.();
      logger.info(`[B2C] Email processing runs every ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    },
    stop() { clearInterval(timer); timer = null; },
  };
}
