"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";

/** Global refresh: pulls HubSpot (incl. emails), Calendly demo dates and case
 * data, then re-renders the current page from the fresh cache. */
export function RefreshButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "err">("idle");

  return (
    <Button
      variant="secondary"
      className="w-full"
      onClick={async () => {
        if (state === "busy") return;
        setState("busy");
        try {
          const res = await fetch("/api/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          // The route answers 500 when any sync kind failed, so res.ok is the truth.
          setState(res.ok ? "idle" : "err");
        } catch {
          setState("err");
        }
        router.refresh();
      }}
      title="Sync HubSpot, Calendly and case data now"
    >
      <RefreshCw className={`h-3.5 w-3.5 ${state === "busy" ? "animate-spin" : ""}`} />
      {state === "busy" ? "Refreshing..." : state === "err" ? "Failed - retry" : "Refresh data"}
    </Button>
  );
}
