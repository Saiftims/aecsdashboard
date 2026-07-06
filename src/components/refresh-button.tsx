"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** Global refresh: pulls HubSpot (incl. emails), Calendly demo dates and case
 * data, then re-renders the current page from the fresh cache. */
export function RefreshButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "err">("idle");

  return (
    <button
      onClick={async () => {
        if (state === "busy") return;
        setState("busy");
        try {
          const res = await fetch("/api/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          setState(res.ok ? "idle" : "err");
        } catch {
          setState("err");
        }
        router.refresh();
      }}
      className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      title="Sync HubSpot, Calendly and case data now"
    >
      <RefreshCw className={`h-3.5 w-3.5 ${state === "busy" ? "animate-spin" : ""}`} />
      {state === "busy" ? "Refreshing..." : state === "err" ? "Failed - retry" : "Refresh data"}
    </button>
  );
}
