"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Subscribe to an SSE endpoint, returning the latest pushed JSON payload. Falls back to interval
 * polling of `fallbackUrl` if EventSource errors (e.g. a proxy that buffers SSE). Reconnects
 * automatically. Use for live state that changes server-side (players/servers).
 */
export function useStream<T>(streamUrl: string, fallbackUrl?: string, fallbackMs = 5000): { data: T | null } {
  const [data, setData] = useState<T | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let alive = true;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const startPoll = () => {
      if (!fallbackUrl || pollTimer) return;
      const load = async () => {
        try {
          const r = await fetch(fallbackUrl, { cache: "no-store" });
          const j = await r.json();
          if (alive) setData(j);
        } catch { /* ignore */ }
      };
      load();
      pollTimer = setInterval(load, fallbackMs);
    };

    try {
      const es = new EventSource(streamUrl);
      esRef.current = es;
      es.onmessage = (e) => {
        if (!alive) return;
        try { setData(JSON.parse(e.data) as T); } catch { /* keep-alive / partial */ }
      };
      es.onerror = () => {
        // EventSource auto-reconnects; if it's persistently failing, lean on polling too.
        startPoll();
      };
    } catch {
      startPoll();
    }

    return () => {
      alive = false;
      esRef.current?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [streamUrl, fallbackUrl, fallbackMs]);

  return { data };
}
