import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";

// Bulk syncs now run in the background (syncJobs.server.js), so a page
// that shows a sync_logs row still "running" polls its loader until the
// run finishes and the real results appear.
export function useRevalidateWhileRunning(logs, intervalMs = 5000) {
  const revalidator = useRevalidator();
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;
  const running = (Array.isArray(logs) ? logs : [logs]).some((log) => log?.status === "running");

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => {
      if (revalidatorRef.current.state === "idle") revalidatorRef.current.revalidate();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [running, intervalMs]);
}
