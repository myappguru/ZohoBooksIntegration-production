import db from "../db.server";

// Runs a bulk "Sync now" job in the background instead of inside the HTTP
// request. A full sync pages through the whole store and makes thousands of
// sequential Zoho calls - long past what the browser, the Apache proxy or
// the Shopify admin will wait for. Progress and results land in sync_logs
// (the pages already show the latest run), so the action only needs to
// report that the job started.
//
// One job of each kind per shop at a time; clicking "Sync now" again while
// one is running is a no-op rather than a second overlapping run.

const runningJobs = new Map();

export function isSyncJobRunning(shopId, jobName) {
  return runningJobs.has(`${shopId}:${jobName}`);
}

export function startSyncJob(shopId, jobName, fn) {
  const key = `${shopId}:${jobName}`;
  if (runningJobs.has(key)) return { started: false, alreadyRunning: true };

  const startedAt = new Date(Date.now() - 1000);
  const job = (async () => {
    try {
      await fn();
    } catch (error) {
      console.error("Background sync job failed", jobName, shopId, error);
      await failRunningSyncLogs({ shopId, since: startedAt, message: error.message || String(error) });
    } finally {
      runningJobs.delete(key);
    }
  })();
  runningJobs.set(key, job);

  return { started: true, job };
}

// A run that throws never reaches finishSyncLog, which used to leave its
// sync_logs row "running" (shown as "In Progress") forever.
export async function failRunningSyncLogs({ shopId, since, message }) {
  await db.execute(
    `UPDATE sync_logs SET status = 'failed', error_message = ?, completed_at = NOW()
     WHERE shop_id = ? AND status = 'running' AND started_at >= ?`,
    [String(message || "Sync failed").slice(0, 2000), shopId, since],
  );
}

// Called once at server start: nothing can still be running from a
// previous process, so any "running" row is an interrupted run.
export async function failInterruptedSyncLogs() {
  await db.execute(
    `UPDATE sync_logs SET status = 'failed', error_message = COALESCE(error_message, 'Interrupted by a server restart'), completed_at = NOW()
     WHERE status = 'running' AND started_at < NOW() - INTERVAL 1 MINUTE`,
  );
}
