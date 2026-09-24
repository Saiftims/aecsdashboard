"use client";

import { clsx } from "clsx";
import { useState, type ReactNode } from "react";
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import { Card, CardHeader, Stat } from "@/components/ui";
import type { LeadSource, UnitEconomicsSnapshot } from "@/lib/unit-economics";

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

const SOURCE_LABEL: Record<LeadSource, string> = {
  meta: "Meta ad lead",
  website: "Website demo booking",
  unknown: "Source not recorded",
  selfserve: "Self-serve app signup",
  conference: "Conference",
  outbound: "Rep outbound",
  referral: "Referral",
  other: "Other",
};
const SOURCE_COLOR: Record<LeadSource, string> = {
  meta: "hsl(210 70% 50%)",
  website: "hsl(160 55% 40%)",
  unknown: "hsl(38 92% 50%)",
  selfserve: "hsl(265 60% 55%)",
  conference: "hsl(0 70% 55%)",
  outbound: "hsl(220 9% 45%)",
  referral: "hsl(190 60% 45%)",
  other: "hsl(220 9% 65%)",
};

type Attribution = "strict" | "likely" | "generous";
/** Which sources the ad spend is credited with. Website bookings arrive
 * through Calendly on the site with no ad form; unrecorded sources are mostly
 * pasted ad-form leads. */
const PAID: Record<Attribution, LeadSource[]> = {
  strict: ["meta"],
  likely: ["meta", "website"],
  generous: ["meta", "website", "unknown"],
};
const ATTR_LABEL: Record<Attribution, string> = {
  strict: "Strict: Meta leads only",
  likely: "Likely: + website bookings",
  generous: "Generous: + unrecorded sources",
};

const HORIZON = 240;
const COLORS = ["hsl(210 70% 50%)", "hsl(265 60% 55%)", "hsl(160 55% 40%)", "hsl(38 92% 50%)", "hsl(0 70% 55%)", "hsl(220 9% 45%)"];
const DAY = 86400000;

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
const day = (iso: string) => iso.slice(0, 10);
const daysBetween = (a: string, b: string) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / DAY));
function mondayOf(iso: string) {
  const t = new Date(day(iso) + "T00:00:00Z");
  return new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
}

const selectCls = "mt-1 w-full rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";

function Input({ label, value: v, onChange, hint }: {
  label: string; value: string; onChange: (v: string) => void; hint?: string;
}) {
  return (
    <label className="block text-xs">
      <span className="font-medium text-zinc-600 dark:text-zinc-300">{label}</span>
      <input type="number" min={0} value={v} onChange={(e) => onChange(e.target.value)} className={selectCls} />
      {hint ? <span className="mt-0.5 block text-zinc-400">{hint}</span> : null}
    </label>
  );
}

function Grid({ headers, rows, highlight, left = 2 }: {
  headers: string[]; rows: ReactNode[][]; highlight: number | number[]; left?: number;
}) {
  const lit = Array.isArray(highlight) ? highlight : [highlight];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
            {headers.map((h, i) => (
              <th key={h + i} className={clsx("px-4 py-2 font-medium", i < left ? "text-left" : "text-right")}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={clsx("border-b border-zinc-100 last:border-0 dark:border-zinc-800/60",
              lit.includes(i) && "bg-blue-50 dark:bg-blue-950/30")}>
              {r.map((c, j) => (
                <td key={j} className={clsx("px-4 py-2", j < left ? "text-left" : "text-right tabular-nums",
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
  const [attr, setAttr] = useState<Attribution>("likely");
  const [otherS, setOther] = useState("0");
  const [convertedS, setConverted] = useState("50");
  const [custom, setCustom] = useState<string[]>(["10", "5", "3", "2"]);

  const margin = num(marginS, snap.grossMargin * 100) / 100;
  const other = num(otherS, 0);
  const converted = Math.min(100, Math.max(num(convertedS, 50), 1)) / 100;
  const paidSet = PAID[attr];

  const era = snap.subscribers.filter((x) => !x.preSwitch);
  const cohorts = snap.months.map((m) => {
    const all = era.filter((x) => x.leadAt.startsWith(m.month));
    const spend = m.spend + other * m.fraction;
    const paidCount = (set: LeadSource[]) => all.filter((x) => set.includes(x.source)).length;
    const paid = paidCount(paidSet);
    const adCac = paid > 0 ? spend / paid : Infinity;
    const teamPer = all.length > 0 ? m.teamCost / all.length : Infinity;
    const complete = m.mature ? 1 : converted;
    return {
      ...m, all, spend, paid, paidCount, adCac, teamPer, fullCac: adCac + teamPer, complete,
      projAdCac: paid > 0 ? spend / (paid / complete) : Infinity,
      projFullCac: paid > 0 ? spend / (paid / complete) + m.teamCost / (all.length / complete) : Infinity,
    };
  });

  // Headline pools settled lead months; while none has settled, every month.
  const settled = cohorts.filter((c) => c.mature);
  const pool = settled.length ? settled : cohorts;
  const poolLabel = pool.map((c) => c.label).join(" + ") + (settled.length ? "" : " (not yet settled)");
  const poolSpend = pool.reduce((a, c) => a + c.spend, 0);
  const poolTeam = pool.reduce((a, c) => a + c.teamCost, 0);
  const poolAll = pool.reduce((a, c) => a + c.all.length, 0);
  const poolMqls = pool.reduce((a, c) => a + c.mqls, 0);
  const poolPaid = (set: LeadSource[]) => pool.reduce((a, c) => a + c.paidCount(set), 0);
  const adCacFor = (set: LeadSource[]) => (poolPaid(set) > 0 ? poolSpend / poolPaid(set) : Infinity);
  const teamCac = poolAll > 0 ? poolTeam / poolAll : Infinity;
  const adCac = adCacFor(paidSet);
  const fullCac = adCac + teamCac;
  const cac = basis === "full" ? fullCac : adCac;
  const basisLabel = basis === "full" ? "fully loaded" : "ads only";
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
  const soloLife = value(solo.contribution, active.s, HORIZON);

  const lags = era.map((x) => daysBetween(x.leadAt, x.subscribedAt)).sort((a, b) => a - b);
  const median = lags.length ? (lags[Math.floor((lags.length - 1) / 2)] + lags[Math.ceil((lags.length - 1) / 2)]) / 2 : 0;
  const lagBuckets = [
    { label: "0–7 days", min: 0, max: 7 }, { label: "8–14", min: 8, max: 14 },
    { label: "15–30", min: 15, max: 30 }, { label: "31–60", min: 31, max: 60 }, { label: "61+", min: 61, max: Infinity },
  ];
  const lagData = lagBuckets.map((b) => ({ bucket: b.label, Subscribers: lags.filter((l) => l >= b.min && l <= b.max).length }));

  const sourcesSeen = (Object.keys(SOURCE_LABEL) as LeadSource[]).filter((s) => era.some((x) => x.source === s));
  const weeks: string[] = [];
  for (let w = mondayOf(snap.months[0]?.month + "-01"); w <= mondayOf(new Date().toISOString()); w = new Date(Date.parse(w) + 7 * DAY).toISOString().slice(0, 10)) weeks.push(w);
  const weekData = weeks.map((w) => {
    const row: Record<string, number | string> = {
      week: new Date(w + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
    };
    for (const s of sourcesSeen) row[SOURCE_LABEL[s]] = era.filter((x) => x.source === s && mondayOf(x.leadAt) === w).length;
    return row;
  });

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
  if (!Number.isFinite(fullCac)) {
    return (
      <Card className="p-4 text-sm text-zinc-500">
        No paid-sourced subscription-era lead has converted yet, so there is no CAC to pay back.
      </Card>
    );
  }
  const attrKeys = Object.keys(PAID) as Attribution[];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Fully loaded CAC" value={usd(fullCac)} tone="warn"
          sub={`${usd(adCac)} ads + ${usd(teamCac)} sales team`} />
        <Stat label="Ad-only CAC" value={usd(adCac)}
          sub={`${poolPaid(paidSet)} paid-sourced subs · ${poolLabel}`} />
        <Stat label={`Solo payback · fully loaded`} value={mo(soloFull)}
          tone={soloFull <= 12 ? "good" : "bad"}
          sub={`${active.label} churn · ${usd(solo.contribution)}/mo margin`} />
        <Stat label={`Solo payback · ads only`} value={mo(soloAds)} tone="good"
          sub="the next ad dollar" />
        <Stat label="Ad cost per MQL" value={usd(poolMqls > 0 ? poolSpend / poolMqls : Infinity)}
          sub={`${poolMqls > 0 ? Math.round((poolAll / poolMqls) * 100) : 0}% of MQLs subscribed`} />
        <Stat label={`Solo lifetime : CAC · ${active.label}`} value={`${(soloLife / fullCac).toFixed(1)}x`}
          sub={`${usd(soloLife)} margin, fully loaded · ${(soloLife / adCac).toFixed(1)}x ads only`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="CAC by lead cohort (subscription plans only)"
            action={<span className="text-xs text-zinc-500">{ATTR_LABEL[attr]}</span>} />
          <Grid left={1}
            headers={["Lead month", "Ad spend", "MQLs", "Subs (all sources)", "Paid-sourced subs", "Ad CAC", "Fully loaded CAC", "Projected ad CAC"]}
            rows={cohorts.map((c) => [
              c.label + (c.mature ? "" : " · still converting"),
              usd(c.spend) + (c.spendFromLedger ? "" : " planned"),
              String(c.mqls), String(c.all.length), String(c.paid),
              usd(c.adCac), usd(c.fullCac),
              c.mature ? "settled" : `${usd(c.projAdCac)} at ${Math.round(c.complete * 100)}% done`,
            ])}
            highlight={cohorts.map((c, i) => (pool.includes(c) ? i : -1))}
          />
          <p className="px-4 pb-3 pt-1 text-xs text-zinc-400">
            A lead month settles three weeks after it ends; until then its later conversions have not happened and
            its CAC is still falling. Projected assumes an unsettled month is the share converted set below.
            Highlighted rows feed the headline.
          </p>
        </Card>
        <Card>
          <CardHeader title="Attribution range" action={<span className="text-xs text-zinc-500">{poolLabel}</span>} />
          <Grid left={1}
            headers={["Counting as paid", "Subs", "Ad CAC", "Solo payback, ads", "Solo payback, loaded"]}
            rows={attrKeys.map((k) => {
              const ad = adCacFor(PAID[k]);
              return [ATTR_LABEL[k], String(poolPaid(PAID[k])), usd(ad),
                mo(payback(ad, solo.contribution, active.s)), mo(payback(ad + teamCac, solo.contribution, active.s))];
            })}
            highlight={attrKeys.indexOf(attr)}
          />
          <p className="px-4 pb-3 pt-1 text-xs text-zinc-400">
            Sources come from Lead Source on the firm&apos;s converting deal or contacts in HubSpot; correct a firm there.
          </p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Subscribers by week the lead came in" />
          <div className="p-4">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={weekData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="week" tick={{ fontSize: 11 }} />
                <YAxis width={28} allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {sourcesSeen.map((s) => (
                  <Bar key={s} dataKey={SOURCE_LABEL[s]} stackId="src" fill={SOURCE_COLOR[s]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
            <p className="text-xs text-zinc-400">Recent weeks read low partly because those leads have not had time to convert.</p>
          </div>
        </Card>
        <Card>
          <CardHeader title="Days from lead to subscription" action={<span className="text-xs text-zinc-500">median {median} days · {era.length} firms</span>} />
          <div className="p-4">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={lagData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                <YAxis width={28} allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="Subscribers" fill="hsl(210 70% 50%)" />
              </BarChart>
            </ResponsiveContainer>
            <p className="text-xs text-zinc-400">Young cohorts can only show short lags, so the true median is somewhat longer.</p>
          </div>
        </Card>
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

      <Card>
        <CardHeader title="Every subscription-era subscriber" />
        <Grid left={6}
          headers={["Firm", "Lead in", "Subscribed", "Days", "Source", "Detail"]}
          rows={snap.subscribers.map((x) => [
            x.firm, day(x.leadAt), day(x.subscribedAt), String(daysBetween(x.leadAt, x.subscribedAt)),
            <span key="s" className={clsx("rounded-full px-2 py-0.5 text-xs",
              !x.preSwitch && paidSet.includes(x.source)
                ? "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200"
                : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300")}>
              {x.preSwitch ? "Lead from before the switch" : SOURCE_LABEL[x.source]}
            </span>,
            x.sourceDetail ?? "",
          ])}
          highlight={-1}
        />
        <p className="px-4 pb-3 pt-1 text-xs text-zinc-400">
          Blue sources count as paid under the selected attribution. Leads from before August are shown but left
          out of every cohort: spend from before the subscription plans bought them.
        </p>
      </Card>

      <Card className="p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <label className="block text-xs">
            <span className="font-medium text-zinc-600 dark:text-zinc-300">Attribution</span>
            <select value={attr} onChange={(e) => setAttr(e.target.value as Attribution)} className={selectCls}>
              {attrKeys.map((k) => <option key={k} value={k}>{ATTR_LABEL[k]}</option>)}
            </select>
          </label>
          <label className="block text-xs">
            <span className="font-medium text-zinc-600 dark:text-zinc-300">CAC basis</span>
            <select value={basis} onChange={(e) => setBasis(e.target.value as "full" | "ads")} className={selectCls}>
              <option value="full">Fully loaded ({usd(fullCac)})</option>
              <option value="ads">Ads only ({usd(adCac)})</option>
            </select>
          </label>
          <label className="block text-xs">
            <span className="font-medium text-zinc-600 dark:text-zinc-300">Highlighted scenario</span>
            <select value={focus} onChange={(e) => setFocus(e.target.value)} className={selectCls}>
              {scenarios.map((sc) => <option key={sc.key} value={sc.key}>{sc.label}</option>)}
            </select>
          </label>
          <Input label="Gross margin (%)" value={marginS} onChange={setMargin}
            hint={`default ${defaultMargin}% from Settings`} />
          <Input label="Unsettled cohort converted so far (%)" value={convertedS} onChange={setConverted}
            hint="of its eventual subscribers" />
          <Input label="Other acquisition spend per month ($)" value={otherS} onChange={setOther}
            hint="agency fees etc. not in the ad ledger" />
          {["M1", "M2", "M3", "M4+"].map((l, i) => (
            <Input key={l} label={`Custom ${l} churn (%)`} value={custom[i]}
              onChange={(v) => setCustom((c) => c.map((x, j) => (j === i ? v : x)))}
              hint={i === 0 ? "cancel before 2nd payment" : i === 3 ? "every month after" : undefined} />
          ))}
        </div>
      </Card>

      <p className="text-xs text-zinc-500">
        CAC is measured by lead cohort: every subscription since the August switch to plans is dated back to
        the lead that converted, and a month&apos;s ad spend is divided only by the subscribers whose source was
        paid. The headline uses {poolLabel}. Ad-only CAC judges the next ad dollar; fully loaded adds the sales
        team cost of {usd(snap.teamCost)}/mo (customer success is not acquisition) spread over every subscriber
        from that lead month, and judges whether acquisition pays for itself. Payback is on gross margin, not
        revenue. Spend by month, sales team cost and margin are set in Settings. Blended is {usd(snap.liveMrr)} live
        billed MRR across {snap.activeSubscribers} paying subscribers; new subscribers this month average{" "}
        {usd(snap.newSubscriberMrr / Math.max(snap.newSubscribers, 1))}/mo, and Boutique and Growth assume the
        same CAC would land a bigger plan. Revenue is subscription only: expert sign-offs and per-case charges
        on top would shorten payback. Churn means subscription cancellations.
      </p>
    </div>
  );
}
