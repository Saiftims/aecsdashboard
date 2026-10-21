"use client";

import { clsx } from "clsx";
import { useState, type ReactNode } from "react";
import { Card, CardHeader, Stat, inputCls } from "@/components/ui";
import type { LeadSource, UnitEconomicsSnapshot } from "@/lib/unit-economics";

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
const ratio = (a: number, b: number) => (Number.isFinite(a / b) && b > 0 ? `${(a / b).toFixed(1)}x` : "—");
const num = (v: string, d: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
const day = (iso: string) => iso.slice(0, 10);
type SubSort = "renews" | "left" | "lead" | "subscribed" | "firm";
type Basis = "started" | "lead";

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

function Grid({ headers, rows, highlight, left = 1, strong = -1 }: {
  headers: string[]; rows: ReactNode[][]; highlight: number; left?: number; strong?: number;
}) {
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
              i === highlight && "bg-blue-50 dark:bg-blue-950/30", i === strong && "font-semibold")}>
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
  const [attr, setAttr] = useState<Attribution>("likely");
  const [custom, setCustom] = useState<string[]>(["10", "5", "3", "2"]);
  const [subSort, setSubSort] = useState<SubSort>("renews");
  // Which month a firm is charged to: the month it started using the product
  // (how the owner reads the table - "we had more than 3 paying in October")
  // or the month its lead came in (what the ad spend actually bought).
  const [basis, setBasis] = useState<Basis>("started");

  const margin = num(marginS, snap.grossMargin * 100) / 100;
  const paidSet = PAID[attr];

  const customBands = custom.map((c, i) => num(c, [10, 5, 3, 2][i])) as Bands;
  const scenarios = [...PRESETS, { key: "custom", label: "Custom", bands: customBands }]
    .map((sc) => ({ ...sc, s: survival(sc.bands) }));
  const focusIdx = Math.max(0, scenarios.findIndex((s) => s.key === focus));
  const active = scenarios[focusIdx];

  /** Fully loaded CAC charges the ad spend to paid-sourced PAYING customers
   * (plan or per-case) and the sales team to every paying customer; a signup
   * that has never sent a case is counted but costs nothing to acquire yet.
   * LTV and payback run on what the cohort actually bills a month - the
   * billed plan for subscribers, the per-case run rate for transactional
   * firms - not a list price. */
  const economics = (spend: number, team: number, custs: typeof snap.customers, s: number[]) => {
    const paying = custs.filter((x) => x.kind !== "signup");
    const paid = paying.filter((x) => paidSet.includes(x.source)).length;
    const adCac = paid > 0 ? spend / paid : Infinity;
    const teamCac = paying.length > 0 ? team / paying.length : Infinity;
    const cac = adCac + teamCac;
    const plan = paying.length ? paying.reduce((a, x) => a + x.monthly, 0) / paying.length : 0;
    const contribution = plan * margin;
    const ltv = value(contribution, s, HORIZON);
    const kinds = {
      signup: custs.filter((x) => x.kind === "signup").length,
      transactional: custs.filter((x) => x.kind === "transactional").length,
      subscription: custs.filter((x) => x.kind === "subscription").length,
    };
    return { paid, paying: paying.length, kinds, adCac, teamCac, cac, plan, contribution, ltv, payback: payback(cac, contribution, s) };
  };
  const kindsText = (k: { signup: number; transactional: number; subscription: number }) =>
    [k.subscription ? `${k.subscription} plan` : "", k.transactional ? `${k.transactional} per-case` : "",
      k.signup ? `${k.signup} signup only` : ""].filter(Boolean).join(" · ") || "—";

  const era = snap.customers.filter((x) => !x.preSwitch);
  const liveSubs = snap.subscribers.filter((x) => x.live);
  const liveCount = liveSubs.length;
  const unusedCount = liveSubs.filter((x) => (x.left ?? 0) > 0).length;
  const dueSoon = liveSubs.filter((x) => (x.left ?? 0) > 0 && (x.daysToRenewal ?? 99) <= 7).length;
  const sortedSubs = [...snap.subscribers].sort((a, b) => {
    // Cancelled plans always sink to the bottom.
    if (a.live !== b.live) return a.live ? -1 : 1;
    switch (subSort) {
      case "renews": return (a.daysToRenewal ?? 9e9) - (b.daysToRenewal ?? 9e9);
      case "left": return (b.left ?? -1) - (a.left ?? -1) || (a.daysToRenewal ?? 9e9) - (b.daysToRenewal ?? 9e9);
      case "subscribed": return b.subscribedAt.localeCompare(a.subscribedAt);
      case "firm": return a.firm.localeCompare(b.firm);
      default: return a.leadAt.localeCompare(b.leadAt);
    }
  });
  // Firms that STARTED using the product since the first cohort month
  // (signup, first case or plan), whatever month their lead came in.
  const startedEra = snap.customers.filter((x) => x.arrivedAt >= `${snap.months[0]?.month ?? "2026-07"}-01`);
  const cohorts = snap.months.map((m) => {
    const fromLeads = era.filter((x) => x.leadAt.startsWith(m.month));
    const arrived = snap.customers.filter((x) => x.arrivedAt.startsWith(m.month));
    const custs = basis === "started" ? arrived : fromLeads;
    return { ...m, custs, fromLeads, arrived, ...economics(m.spend, m.teamCost, custs, active.s) };
  });
  const totalSpend = cohorts.reduce((a, c) => a + c.spend, 0);
  const totalTeam = cohorts.reduce((a, c) => a + c.teamCost, 0);
  const allCusts = basis === "started" ? startedEra : era;
  const total = economics(totalSpend, totalTeam, allCusts, active.s);

  if (!Number.isFinite(total.cac)) {
    return (
      <Card className="p-4 text-sm text-zinc-500">
        No paid-sourced lead has become a paying customer yet, so there is no CAC to pay back.
      </Card>
    );
  }

  const totalLeads = cohorts.reduce((a, c) => a + (c.adLeads ?? 0), 0);
  const cohortRows = [...cohorts.map((c) => ({ ...c, name: c.label + (c.mature ? "" : " · still converting") })),
    { name: "All months", spend: totalSpend, teamCost: totalTeam, custs: allCusts, fromLeads: era, arrived: startedEra,
      spendFromLedger: true, spendSource: "meta" as const,
      adLeads: cohorts.every((c) => c.adLeads !== null) ? totalLeads : null, ...total }];
  const fromMeta = cohorts.some((c) => c.spendSource === "meta");
  const kindCount = (list: typeof snap.customers) => ({
    signup: list.filter((x) => x.kind === "signup").length,
    transactional: list.filter((x) => x.kind === "transactional").length,
    subscription: list.filter((x) => x.kind === "subscription").length,
  });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="CAC, fully loaded" value={usd(total.cac)} tone="warn"
          sub={`${usd(total.adCac)} ads + ${usd(total.teamCac)} sales & CS salaries (${usd(snap.teamCost * 12)}/yr now)`} />
        <Stat label={`LTV, fully loaded · ${active.label}`} value={usd(total.ltv)}
          sub={`${usd(total.plan)}/mo average per paying firm · ${Math.round(margin * 100)}% margin`} />
        <Stat label="LTV : CAC" value={ratio(total.ltv, total.cac)}
          tone={total.ltv / total.cac >= 3 ? "good" : "bad"}
          sub={`${allCusts.length} firms since July: ${kindsText(total.kinds)}`} />
        <Stat label="Payback" value={mo(total.payback)} tone={total.payback <= 12 ? "good" : "bad"}
          sub={`${usd(total.contribution)}/mo margin per paying firm`} />
      </div>

      <Card>
        <CardHeader title={basis === "started" ? "Unit economics by month started" : "Unit economics by lead month"}
          action={
            <label className="flex items-center gap-2 text-xs text-zinc-500">
              <span>{active.label} churn · {ATTR_LABEL[attr]}</span>
              <select className={inputCls} value={basis} onChange={(e) => setBasis(e.target.value as Basis)}>
                <option value="started">Count firms by month they started</option>
                <option value="lead">Count firms by month their lead came in</option>
              </select>
            </label>
          } />
        <Grid
          headers={["Month", "Firms signed up", "Ad spend", "Meta leads", "Cost / lead", "Sales & CS salaries",
            basis === "started" ? "Of which from earlier months' leads" : "Won from this month's leads",
            "Paying", "Paid-sourced", "CAC, fully loaded", "Avg $/mo", "LTV, fully loaded", "LTV : CAC", "Payback"]}
          left={2}
          rows={cohortRows.map((c) => [
            c.name,
            <span key="arrived">
              <span className="text-base font-semibold">{c.arrived.length}</span>
              <span className="block text-[11px] font-normal text-zinc-400">{kindsText(kindCount(c.arrived))}</span>
            </span>,
            usd(c.spend) + (c.spendSource === "planned" ? " planned" : c.spendSource === "ledger" ? " (typed)" : ""),
            c.adLeads === null ? "—" : String(c.adLeads),
            c.adLeads ? usd(c.spend / c.adLeads) : "—",
            <span key="team" title={"peopleAnnual" in c ? `${usd(c.peopleAnnual)}/yr in force` : undefined}>{usd(c.teamCost)}</span>,
            basis === "started"
              ? String(c.arrived.filter((x) => x.leadAt.slice(0, 7) < (c.name === "All months" ? "2026-07" : x.arrivedAt.slice(0, 7))).length)
              : <span key="custs">
                {c.fromLeads.length}
                <span className="block text-[11px] font-normal text-zinc-400">{kindsText(kindCount(c.fromLeads))}</span>
              </span>,
            String(c.paying), String(c.paid),
            usd(c.cac), c.paying ? `${usd(c.plan)}/mo` : "—",
            usd(c.ltv), ratio(c.ltv, c.cac), mo(c.payback),
          ])}
          highlight={-1} strong={cohortRows.length - 1}
        />
        <p className="px-4 pb-3 pt-1 text-xs text-zinc-400">
          Every firm that has used the product is here - on a plan, paying per case, or signed up and yet to send a
          case. &ldquo;Firms signed up&rdquo; is how many started in that calendar month (first app signup, first case
          or plan, whichever came first) - a firm that bought a plan through Stripe without ever signing into the app
          counts here too.
          {basis === "started"
            ? " Paying, CAC and LTV run on those same firms, so a month's ad spend is set against firms that started that month even when their lead came in earlier - most take weeks to convert, so the latest month flatters itself and the previous one is undersold. Switch the basis to charge each firm to the month its lead came in."
            : " Paying, CAC and LTV run on \u201cwon from this month\u2019s leads\u201d, which dates each firm back to the month its lead came in: that month\u2019s ad spend over its paid-sourced paying firms plus the people cost over all of its paying firms. The two counts differ because most firms take weeks to convert."}
          {" CAC, fully loaded = ad spend ÷ paid-sourced paying firms + that month's sales & CS salaries (the annual figure in force ÷ 12, prorated) ÷ all paying firms."}
          {" "}Avg $/mo is the billed plan for subscribers and the per-case cash run rate for transactional firms
          (Stripe cash where Stripe knows the firm, else $250 a case).
          LTV is lifetime gross margin on that under the selected churn, capped at {HORIZON / 12} years. A month keeps
          converting for weeks after it ends, so the latest month&apos;s CAC is still falling.
          {fromMeta
            ? " Ad spend and Meta leads are actuals from the Meta Ads account (synced every 6 hours); a month marked (typed) is the Settings ledger, used only when Meta has no data for it."
            : " Ad spend is the Settings ledger; the Meta spend sync has not run yet."}
        </p>
      </Card>

      <Card>
        <CardHeader title="All months under each churn assumption" />
        <Grid
          headers={["Churn", "M1 / M2 / M3 / M4+", "Still paying at M12", "12-mo value", "LTV, fully loaded", "LTV : CAC", "Payback"]}
          rows={scenarios.map((sc) => {
            const ltv = value(total.contribution, sc.s, HORIZON);
            return [
              sc.label, sc.bands.map((b) => `${b}%`).join(" / "), `${Math.round(sc.s[12] * 100)}%`,
              usd(value(total.contribution, sc.s, 12)), usd(ltv), ratio(ltv, total.cac),
              mo(payback(total.cac, total.contribution, sc.s)),
            ];
          })}
          highlight={focusIdx}
        />
      </Card>

      <Card>
        <CardHeader title="Every subscriber"
          action={
            <label className="flex items-center gap-2 text-xs text-zinc-500">
              <span>{liveCount} live · {unusedCount} with cases left{dueSoon ? ` · ${dueSoon} renewing within 7 days` : ""}</span>
              <select className={inputCls} value={subSort} onChange={(e) => setSubSort(e.target.value as SubSort)}>
                <option value="renews">Renews soonest</option>
                <option value="left">Most cases left</option>
                <option value="lead">Lead date</option>
                <option value="subscribed">Subscribed date</option>
                <option value="firm">Firm A–Z</option>
              </select>
            </label>
          } />
        <Grid left={2}
          headers={["Firm", "Plan", "$/mo", "Subscribed", "Renews", "Cases this period", "Cases left", "Lead in", "Source"]}
          rows={sortedSubs.map((x) => {
            const soon = x.live && (x.left ?? 0) > 0 && (x.daysToRenewal ?? 99) <= 7;
            return [
              x.firm,
              <span key="p">
                {x.live ? x.planName : <span className="text-zinc-400">Cancelled</span>}
                {x.note ? <span className="block text-xs text-zinc-400">{x.note}</span> : null}
              </span>,
              `${usd(x.plan)}`,
              day(x.subscribedAt),
              x.periodEnd
                ? <span key="r" className={clsx(soon && "font-semibold text-amber-600")}>
                    {day(x.periodEnd)}{x.daysToRenewal !== null ? <span className="ml-1 text-xs opacity-70">{x.daysToRenewal <= 0 ? "today" : `${x.daysToRenewal}d`}</span> : null}
                  </span>
                : "—",
              x.casesThisPeriod === null ? "—" : `${x.casesThisPeriod}${x.included !== null ? ` / ${x.included}` : ""}`,
              x.left === null ? "—"
                : <span key="l" className={clsx((x.left ?? 0) > 0 ? "font-semibold text-amber-600" : "text-zinc-400")}>{x.left}</span>,
              day(x.leadAt),
              <span key="s" className={clsx("rounded-full px-2 py-0.5 text-xs",
                !x.preSwitch && paidSet.includes(x.source)
                  ? "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300")}>
                {x.preEra ? "Before plans launched" : x.preSwitch ? "Lead from before July" : SOURCE_LABEL[x.source]}
              </span>,
            ];
          })}
          highlight={-1}
        />
        <p className="px-4 pb-3 pt-1 text-xs text-zinc-400">
          Plan and renewal date from Stripe (synced every 3 hours); cases this period are the firm&apos;s submitted
          cases dated inside the current billing period, against the plan&apos;s allowance (Solo 2, Boutique 5,
          Growth 10). Firms renewing within 7 days with cases left are amber. Blue sources count as paid under the
          selected attribution; a plan from before August is listed but belongs to no cohort. Sources come from
          Lead Source on the firm&apos;s converting deal or contacts in HubSpot; correct a firm there.
        </p>
      </Card>

      <Card className="p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <label className="block text-xs">
            <span className="font-medium text-zinc-600 dark:text-zinc-300">Churn assumption</span>
            <select value={focus} onChange={(e) => setFocus(e.target.value)} className={selectCls}>
              {scenarios.map((sc) => <option key={sc.key} value={sc.key}>{sc.label}</option>)}
            </select>
          </label>
          <label className="block text-xs">
            <span className="font-medium text-zinc-600 dark:text-zinc-300">Attribution</span>
            <select value={attr} onChange={(e) => setAttr(e.target.value as Attribution)} className={selectCls}>
              {(Object.keys(PAID) as Attribution[]).map((k) => <option key={k} value={k}>{ATTR_LABEL[k]}</option>)}
            </select>
          </label>
          <Input label="Gross margin (%)" value={marginS} onChange={setMargin}
            hint={`default ${defaultMargin}% from Settings`} />
          <div />
          {["M1", "M2", "M3", "M4+"].map((l, i) => (
            <Input key={l} label={`Custom ${l} churn (%)`} value={custom[i]}
              onChange={(v) => setCustom((c) => c.map((x, j) => (j === i ? v : x)))}
              hint={i === 0 ? "cancel before 2nd payment" : i === 3 ? "every month after" : undefined} />
          ))}
        </div>
      </Card>

      <p className="text-xs text-zinc-500">
        Per-case charges and expert sign-offs on top of plans would shorten payback. The people cost in CAC is the
        sales & CS salary bill in force each month ({usd(snap.teamCost * 12)}/yr now), customer success included
        because the CSM runs demos and owns the book. Ad spend comes from Meta; the salary ledger and the margin
        are set in Settings. Live billed MRR is {usd(snap.liveMrr)} across{" "}
        {snap.activeSubscribers} paying subscribers.
      </p>
    </div>
  );
}
