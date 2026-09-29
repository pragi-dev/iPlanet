// Periodic proactive-service scan. It runs inside the API process on Render,
// and the same `run` is exposed on a secret-protected endpoint so an external
// scheduler (Render Cron Job, GitHub Actions, uptime pinger) can trigger it when
// the web service sleeps or runs several instances. Runs never overlap, and the
// engine's notification keys make repeated runs harmless.
export function createProactiveScheduler({ engine, minutes, logger = console }) {
  let running = null;
  let timer = null;
  let lastRun = null;

  async function run(trigger = 'manual') {
    if (running) return running;
    running = (async () => {
      const startedAt = new Date();
      try {
        const result = await engine.sync({ notify: true });
        lastRun = { trigger, startedAt, finishedAt: new Date(), ok: true, checkedDevices: result.checkedDevices, followUps: result.items.length, insufficientData: result.insufficientData };
        logger.info?.(`[Proactive service] ${trigger} scan: ${result.checkedDevices} devices checked, ${result.items.length} active follow-ups.`);
      } catch (error) {
        lastRun = { trigger, startedAt, finishedAt: new Date(), ok: false, error: error.message };
        logger.error?.(`[Proactive service] ${trigger} scan failed: ${error.message}`);
      } finally {
        running = null;
      }
      return lastRun;
    })();
    return running;
  }

  function start() {
    if (!minutes || timer) return;
    // First scan shortly after start-up, then on the configured cadence.
    const first = setTimeout(() => { void run('startup'); }, 15000);
    timer = setInterval(() => { void run('interval'); }, minutes * 60000);
    first.unref?.();
    timer.unref?.();
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { run, start, stop, status: () => ({ intervalMinutes: minutes, lastRun, running: Boolean(running) }) };
}
