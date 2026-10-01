// react-router-serve answers SIGTERM/SIGINT by closing its HTTP listener and
// nothing else. The MySQL pools keep the event loop busy, so the process
// never exits: it lingers without a port, still running the webhook retry
// sweep with whatever (old) code it was started with, next to the new server.
// Give in-flight requests a grace period, then exit for real. Sync runs cut
// off here are marked failed on the next start (failInterruptedSyncLogs).
export const SHUTDOWN_GRACE_MS = 10 * 1000;

export function installShutdownHandlers({
  proc = process,
  exit = (code) => process.exit(code),
  graceMs = SHUTDOWN_GRACE_MS,
  stopBackgroundWork = () => {},
} = {}) {
  let shuttingDown = false;

  const onSignal = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, exiting in ${graceMs / 1000}s`);
    try {
      stopBackgroundWork();
    } catch (error) {
      console.error("Failed to stop background work", error);
    }
    const timer = setTimeout(() => exit(0), graceMs);
    // Don't hold the process open just for this timer if it can exit sooner.
    timer.unref?.();
  };

  proc.on("SIGTERM", onSignal);
  proc.on("SIGINT", onSignal);

  return () => {
    proc.off("SIGTERM", onSignal);
    proc.off("SIGINT", onSignal);
  };
}
