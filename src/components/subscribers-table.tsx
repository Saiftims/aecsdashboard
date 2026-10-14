"use client";

import { clsx } from "clsx";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, Card } from "@/components/ui";
import type { SubscriberRow } from "@/lib/subscribers";

type Key = "firm" | "plan" | "monthly" | "periodStart" | "daysToRenewal" | "casesThisPeriod" | "left" | "casesLast30" | "lastCase";

const COLS: { key: Key; label: string; right?: boolean }[] = [
  { key: "firm", label: "Firm" },
  { key: "plan", label: "Plan" },
  { key: "monthly", label: "$/mo", right: true },
  { key: "periodStart", label: "Period started" },
  { key: "daysToRenewal", label: "Renews" },
  { key: "casesThisPeriod", label: "Cases this period", right: true },
  { key: "left", label: "Cases left", right: true },
  { key: "casesLast30", label: "Last 30d", right: true },
  { key: "lastCase", label: "Last case" },
];

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "—");

export function SubscribersTable({ rows }: { rows: SubscriberRow[] }) {
  const [sort, setSort] = useState<Key>("daysToRenewal");
  const [asc, setAsc] = useState(true);
  const [onlyUnused, setOnlyUnused] = useState(false);

  const sorted = useMemo(() => {
    const list = onlyUnused ? rows.filter((r) => (r.left ?? 0) > 0) : rows;
    const dir = asc ? 1 : -1;
    return [...list].sort((a, b) => {
      const x = a[sort], y = b[sort];
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      if (typeof x === "number" && typeof y === "number") return dir * (x - y);
      return dir * String(x).localeCompare(String(y));
    });
  }, [rows, sort, asc, onlyUnused]);

  const click = (k: Key) => {
    if (k === sort) setAsc(!asc);
    else { setSort(k); setAsc(k === "firm" || k === "plan" || k === "periodStart" || k === "daysToRenewal" || k === "lastCase"); }
  };

  const unused = rows.filter((r) => (r.left ?? 0) > 0);
  const soon = unused.filter((r) => (r.daysToRenewal ?? 99) <= 7);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
        <div className="text-zinc-500">
          <span className="font-medium text-zinc-900 dark:text-zinc-100">{rows.length} subscribers</span>
          {" · "}{unused.length} with unused cases{soon.length ? <>, <span className="font-medium text-amber-600">{soon.length} renewing within 7 days</span></> : ""}
        </div>
        <label className="flex items-center gap-2 text-zinc-600 dark:text-zinc-300">
          <input type="checkbox" checked={onlyUnused} onChange={(e) => setOnlyUnused(e.target.checked)} />
          Only firms with cases left
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              {COLS.map((c) => (
                <th key={c.key} className={clsx("cursor-pointer select-none px-3 py-2 font-medium hover:text-zinc-900 dark:hover:text-zinc-100", c.right && "text-right")} onClick={() => click(c.key)}>
                  {c.label}{sort === c.key ? (asc ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const dueSoon = (r.daysToRenewal ?? 99) <= 7;
              const hasLeft = (r.left ?? 0) > 0;
              return (
                <tr key={`${r.source}:${r.companyId ?? r.firm}`} className={clsx("border-b border-zinc-100 last:border-0 dark:border-zinc-800/60", dueSoon && hasLeft && "bg-amber-50/60 dark:bg-amber-950/20")}>
                  <td className="px-3 py-2 font-medium">
                    {r.companyId ? <Link href={`/firms/${r.companyId}`} className="hover:underline">{r.firm}</Link> : r.firm}
                    {!r.companyId ? <span className="ml-1 text-xs text-zinc-400" title="Stripe customer not matched to a HubSpot company; cases cannot be counted">no HubSpot match</span> : null}
                  </td>
                  <td className="px-3 py-2">
                    {r.plan}
                    {r.cancelAtPeriodEnd ? <Badge tone="red">cancels at renewal</Badge> : r.status === "past_due" ? <Badge tone="yellow">past due</Badge> : null}
                    {r.note ? <div className="text-xs text-zinc-400">{r.note}</div> : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">${r.monthly.toLocaleString("en-US")}{r.interval === "year" ? <span className="text-xs text-zinc-400"> (annual)</span> : ""}</td>
                  <td className="px-3 py-2 tabular-nums">{day(r.periodStart)}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {day(r.periodEnd)}
                    {r.daysToRenewal !== null ? <span className={clsx("ml-1 text-xs", dueSoon ? "font-medium text-amber-600" : "text-zinc-400")}>{r.daysToRenewal <= 0 ? "today" : `in ${r.daysToRenewal}d`}</span> : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.casesThisPeriod}{r.included !== null ? <span className="text-zinc-400"> / {r.included}</span> : ""}</td>
                  <td className={clsx("px-3 py-2 text-right tabular-nums font-semibold", hasLeft ? "text-amber-600" : "text-zinc-400")}>{r.left === null ? "—" : r.left}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.casesLast30}</td>
                  <td className="px-3 py-2 tabular-nums text-zinc-500">{day(r.lastCase)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-3 text-xs text-zinc-400">
        Plan and billing period from Stripe (synced every 3 hours). Cases this period are the firm&apos;s submitted cases dated inside the current period.
        Included cases per plan from the pricing page: Solo 2, Boutique 5, Growth 10; custom plans show no allowance. Click a column to sort.
      </p>
    </Card>
  );
}
