"use client";

import { clsx } from "clsx";
import { useState } from "react";
import {
  CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import { Card, CardHeader, Stat } from "@/components/ui";
import type { UnitEconomicsSnapshot } from "@/lib/unit-economics";

const PLANS = [
  { label: "Solo", price: 300 },
  { label: "Boutique", price: 600 },
  { label: "Growth", price: 1000 },
];

type Bands = [number, number, number, number];

/** Subscription cancellations: month 1 is the share that cancels before the
 * second payment, month 2 before the third, month 3 before the fourth, and the
 * last band repeats every month after that. */
const PRESETS: { key: string; label: string; bands: Bands }[] = [
  { key: "none", label: "No churn", bands: [0, 0, 0, 0] },
  { key: "optimistic", label: "Optimistic", bands: [5, 3, 2, 1] },
  { key: "base", label: "Base", bands: [10, 5, 3, 2] },
  { key: "pessimistic", label: "Pessimistic", bands: [20, 10, 5, 3] },
  { key: "severe", label: "Severe", bands: [30, 15, 8, 4] },
];

const HORIZON = 240;
const COLORS = ["hsl(210 70% 50%)", "hsl(265 60% 55%)", "hsl(160 55% 40%)", "hsl(38 92% 50%)", "hsl(0 70% 55%)", "hsl(220 9% 45%)"];

/** Share of an acquired cohort still subscribed and paying in month m+1. */
function survival(bands: Bands): number[] {
  const out: number[] = [];
  let alive = 1;
  for (let m = 1; m <= HORIZON; m++) {
    out.push(alive);
    alive *= 1 - (m <= 3 ? bands[m - 1] : bands[3]) / 100;
  }
  return out;
}

/** Months until expected contribution covers CAC; revenue earned evenly across
 * each month. */
function payback(cac: number, monthly: number, s: number[]) {
  let cum = 0;
  for (let m = 0; m < s.length; m++) {
    const earn = monthly * s[m];
    if (earn <= 0) break;
    if (cum + earn >= cac) return m + (cac - cum) / earn;
    cum += earn;
  }
  return Infinity;
}

const value = (monthly: number, s: number[], months: number) =>
  s.slice(0, months).reduce((a, x) => a + x * monthly, 0);

const usd = (n: number) => (Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "—");
const mo = (n: number) => (Number.isFinite(n) ? `${n.toFixed(1)} mo` : "never");
const num = (v: string, d: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);

function Input({ label, value: v, onChange, hint }: {
  label: string; value: string; onChange: (v: string) => void; hint?: string;
}) {
  return (
    <label className="block text-xs">
      <span className="font-medium text-zinc-600 dark:text-zinc-300">{label}</span>
      <input
        type="number" min={0} value={v} onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      />
      {hint ? <span className="mt-0.5 block text-zinc-400">{hint}</span> : null}
    </label>
  );
}

function Grid({ headers, rows, highlight }: {
  headers: string[]; rows: string[][]; highlight: number;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
            {headers.map((h, i) => (
              <th key={h} className={clsx("px-4 py-2 font-medium", i < 2 ? "text-left" : "text-right")}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={clsx("border-b border-zinc-100 last:border-0 dark:border-zinc-800/60",
              i === highlight && "bg-blue-50 dark:bg-blue-950/30")}>
              {r.map((c, j) => (
                <td key={j} className={clsx("px-4 py-2", j < 2 ? "text-left" : "text-right tabular-nums",
                  j === 0 && "font-medium")}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UnitEconomics({ snap }: { snap: UnitEconomicsSnapshot }) {
  const defaultMargin = String(Math.round(snap.grossMargin * 100));
  const [marginS, setMargin] = useState(defaultMargin);
  const [focus, setFocus] = useState("base");
  const [basis, setBasis] = useState<"full" | "ads">("full");
  const [custom, setCustom] = useState<string[]>(["10", "5", "3", "2"]);

  const margin = num(marginS, snap.grossMargin * 100) / 100;
  const adSubs = snap.newSubscribers * snap.adLeadShare;
  const adMqls = snap.mqls * snap.adLeadShare;
  const adCac = adSubs > 0 ? snap.adSpend / adSubs : Infinity;
  // Ads are credited only with the subscribers they sourced; the team works
  // every new subscriber, whatever the source.
  const teamCac = snap.newSubscribers > 0 ? snap.teamCost / snap.newSubscribers : Infinity;
  const fullCac = adCac + teamCac;
  const cac = basis === "full" ? fullCac : adCac;
  const basisLabel = basis === "full" ? "fully loaded" : "ads only";
  const costPerMql = adMqls > 0 ? snap.adSpend / adMqls : Infinity;
  const conversion = snap.mqls > 0 ? snap.newSubscribers / snap.mqls : 0;
  const arpa = snap.activeSubscribers ? snap.liveMrr / snap.activeSubscribers : 0;

  const customBands = custom.map((c, i) => num(c, [10, 5, 3, 2][i])) as Bands;
  const scenarios = [...PRESETS, { key: "custom", label: "Custom", bands: customBands }]
    .map((sc) => ({ ...sc, s: survival(sc.bands) }));
  const focusIdx = Math.max(0, scenarios.findIndex((s) => s.key === focus));
  const active = scenarios[focusIdx];

  const packages = [
    ...PLANS.map((p) => ({ label: `${p.label} $${p.price}`, name: p.label, price: p.price })),
    { label: `Blended $${Math.round(arpa)}`, name: "Blended", price: arpa },
  ].map((p) => ({ ...p, contribution: p.price * margin }));
  const blended = packages[packages.length - 1];
  const solo = packages[0];
  const soloFull = payback(fullCac, solo.contribution, active.s);
  const soloAds = payback(adCac, solo.contribution, active.s);
  const blendedLife = value(blended.contribution, active.s, HORIZON);

  const survivalData = Array.from({ length: 13 }, (_, m) => {
    const row: Record<string, number | string> = { month: `M${m}` };
    for (const sc of scenarios) {
      if (sc.key === "custom" && focus !== "custom") continue;
      row[sc.label] = m === 0 ? 100 : Math.round(sc.s[m - 1] * 1000) / 10;
    }
    return row;
  });
  const cumData = Array.from({ length: 7 }, (_, m) => {
    const row: Record<string, number | string> = { month: `Month ${m}` };
    for (const p of packages) row[p.name] = Math.round(value(p.contribution, active.s, m));
    return row;
  });
  const partial = snap.daysElapsed < snap.daysInMonth;

  if (!Number.isFinite(fullCac)) {
    return (
      <Card className="p-4 text-sm text-zinc-500">
        No new paying subscribers yet in {snap.monthLabel}, so there is no CAC to pay back.
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Fully loaded CAC" value={usd(fullCac)} tone="warn"
          sub={`${usd(adCac)} ads + ${usd(teamCac)} GTM team`} />
        <Stat label="Ad-only CAC" value={usd(adCac)}
          sub={`${usd(snap.adSpend)} ÷ ${adSubs.toFixed(1)} ad-sourced subs`} />
        <Stat label={`Solo payback · fully loaded`} value={mo(soloFull)}
          tone={soloFull <= 12 ? "good" : "bad"}
          sub={`${active.label} churn · ${usd(solo.contribution)}/mo margin`} />
        <Stat label={`Solo payback · ads only`} value={mo(soloAds)} tone="good"
          sub="the next ad dollar" />
        <Stat label="Ad cost per MQL" value={usd(costPerMql)}
          sub={`${snap.mqls} MQLs · ${Math.round(conversion * 100)}% MQL → sub`} />
        <Stat label={`Lifetime : CAC · ${active.label}`} value={`${(blendedLife / fullCac).toFixed(1)}x`}
          sub={`${usd(blendedLife)} blended margin, fully loaded`} />
      </div>

      <Card>
        <CardHeader title="Payback by package and churn scenario"
          action={<span className="text-xs text-zinc-500">months of gross margin to earn back {usd(cac)} ({basisLabel})</span>} />
        <Grid
          headers={["Scenario", "Churn M1 / M2 / M3 / M4+", ...packages.map((p) => p.label)]}
          rows={scenarios.map((sc) => [
            sc.label, sc.bands.map((b) => `${b}%`).join(" / "),
            ...packages.map((p) => mo(payback(cac, p.contribution, sc.s))),
          ])}
          highlight={focusIdx}
        />
      </Card>

      <Card>
        <CardHeader title={`Gross margin per acquired firm (blended) vs ${basisLabel} CAC`} />
        <Grid
          headers={["Scenario", "Still paying at M12", "12-mo value", "24-mo value", "Lifetime value", "Lifetime : CAC", "Solo lifetime : CAC"]}
          rows={scenarios.map((sc) => {
            const life = value(blended.contribution, sc.s, HORIZON);
            return [
              sc.label, `${Math.round(sc.s[12] * 100)}%`,
              usd(value(blended.contribution, sc.s, 12)),
              usd(value(blended.contribution, sc.s, 24)),
              usd(life), `${(life / cac).toFixed(1)}x`,
              `${(value(packages[0].contribution, sc.s, HORIZON) / cac).toFixed(1)}x`,
            ];
          })}
          highlight={focusIdx}
        />
        <p className="px-4 pb-3 pt-1 text-xs text-zinc-400">
          Lifetime value is capped at {HORIZON / 12} years; with no churn that cap is the whole figure.
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Share of acquired firms still subscribed (%)" />
          <div className="p-4">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={survivalData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis width={36} domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => `${v}%`} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {scenarios.filter((sc) => sc.key !== "custom" || focus === "custom").map((sc, i) => (
                  <Line key={sc.key} type="monotone" dataKey={sc.label} stroke={COLORS[i % COLORS.length]}
                    strokeWidth={sc.key === focus ? 3 : 1.5} dot={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card>
          <CardHeader title={`Cumulative gross margin per firm vs ${basisLabel} CAC · ${active.label} churn`} />
          <div className="p-4">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={cumData} margin={{ right: 56 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis width={52} tick={{ fontSize: 11 }} tickFormatter={(v) => `$${(Number(v) / 1000).toFixed(1)}k`} />
                <Tooltip formatter={(v) => usd(Number(v))} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine y={Math.round(cac)} stroke="hsl(0 70% 50%)" strokeDasharray="5 4"
                  label={{ value: `CAC ${usd(cac)}`, position: "right", fontSize: 10, fill: "hsl(0 70% 45%)" }} />
                {packages.map((p, i) => (
                  <Line key={p.name} type="monotone" dataKey={p.name} stroke={COLORS[i]} strokeWidth={2} dot={{ r: 2 }} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <Card className="p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-7">
          <label className="block text-xs">
            <span className="font-medium text-zinc-600 dark:text-zinc-300">CAC basis</span>
            <select value={basis} onChange={(e) => setBasis(e.target.value as "full" | "ads")}
              className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900">
              <option value="full">Fully loaded ({usd(fullCac)})</option>
              <option value="ads">Ads only ({usd(adCac)})</option>
            </select>
          </label>
          <label className="block text-xs">
            <span className="font-medium text-zinc-600 dark:text-zinc-300">Highlighted scenario</span>
            <select value={focus} onChange={(e) => setFocus(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900">
              {scenarios.map((sc) => <option key={sc.key} value={sc.key}>{sc.label}</option>)}
            </select>
          </label>
          <Input label="Gross margin (%)" value={marginS} onChange={setMargin}
            hint={`default ${defaultMargin}% from Settings`} />
          {["M1", "M2", "M3", "M4+"].map((l, i) => (
            <Input key={l} label={`Custom ${l} churn (%)`} value={custom[i]}
              onChange={(v) => setCustom((c) => c.map((x, j) => (j === i ? v : x)))}
              hint={i === 0 ? "cancel before 2nd payment" : i === 3 ? "every month after" : undefined} />
          ))}
        </div>
      </Card>

      <p className="text-xs text-zinc-500">
        {snap.monthLabel} to date{partial ? ` (day ${snap.daysElapsed} of ${snap.daysInMonth})` : ""}.
        Ad-only CAC = ad spend ÷ (new paying subscribers × share of MQLs from ads): {usd(snap.adSpend)} ÷ ({snap.newSubscribers} ×{" "}
        {Math.round(snap.adLeadShare * 100)}%) — use it to judge the next ad dollar. Fully loaded adds the total GTM team cost of{" "}
        {usd(snap.teamCost)}/mo, spread over all {snap.newSubscribers} new subscribers — use it to judge
        whether go-to-market pays for itself. Payback is on gross margin, not revenue. Spend, team cost and margin are set in
        Settings. Blended is{" "}
        {usd(snap.liveMrr)} live billed MRR across {snap.activeSubscribers} paying subscribers, after
        discounts. New subscribers this month average {usd(snap.newSubscriberMrr / Math.max(snap.newSubscribers, 1))}/mo;
        Boutique and Growth assume the same CAC would land a bigger plan. Revenue is subscription only, so
        per-case charges on top would shorten payback. Churn means subscription cancellations; every firm pays
        month 1, so payback barely moves with churn while lifetime value does.
        {partial ? " Spend is the whole month's but subscribers are to date, so CAC falls as the month fills in." : ""}
      </p>
    </div>
  );
}
