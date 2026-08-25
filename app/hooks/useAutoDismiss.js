import { useEffect, useState } from "react";

const DEFAULT_DELAY_MS = 6000;

// Shows content tied to `key` (e.g. a sync_logs row id) immediately, then
// auto-hides it after `delayMs` - used for the "Last sync" result banners
// so they don't sit on the page forever. Re-arms (shows again) whenever
// `key` changes, i.e. a new sync just completed.
export function useAutoDismiss(key, delayMs = DEFAULT_DELAY_MS) {
  const [visible, setVisible] = useState(Boolean(key));

  useEffect(() => {
    if (!key) return;

    setVisible(true);
    const timer = setTimeout(() => setVisible(false), delayMs);

    return () => clearTimeout(timer);
  }, [key, delayMs]);

  return visible;
}
