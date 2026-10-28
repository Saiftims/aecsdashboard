"use client";

import { clsx } from "clsx";
import { useState } from "react";
import {
  Badge, Card, CardBody, CardHeader, Cell, Empty, Field, Note, Stat, StatGrid, Table, inputCls, selectCls,
  type Column,
} from "@/components/ui";
import type { LeadSource, UnitEconomicsSnapshot } from "@/lib/unit-economics";
import { observedSurvival, type ObservedRetention } from "@/lib/observed-churn";

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

/** LTV is counted over a fixed number of months. The measured retention
 * curve levels off (owner, 2026-10-21: "lets assume it levels off at 83%"),
 * so without a horizon the figure would be unbounded; 36 months is the usual
 * SaaS convention and is the default. */
const HORIZONS = [12, 24, 36, 60] as const;
const DEFAULT_HORIZON = 36;

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

const right = (label: string, width?: string): Column => ({ label, align: "right", width });
const left = (label: string, width?: string): Column => ({ label, align: "left", width });

const COHORT_HEADERS: Column[] = [
  left("Month", "14%"), left("Firms signed up", "15%"), right("Meta + FlyTech", "10%"), right("Cost / lead", "9%"),
  right("Paying", "11%"), right("CAC", "10%"), right("Avg $/mo", "8%"), right("LTV", "9%"),
  right("LTV : CAC", "7%"), right("Payback", "7%"),
];

const SUBSCRIBER_HEADERS: Column[] = [
  left("Firm"), left("Plan"), right("$/mo"), right("Subscribed"), right("Renews"), right("Cases this period"),
  right("Cases left"), right("Lead in"), right("Source"),
];

function NumberInput({ label, value: v, onChange, hint }: {
  label: string; value: string; onChange: (v: string) => void; hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <input type="number" min={0} value={v} onChange={(e) => onChange(e.target.value)} className={inputCls} />
    </Field>
  );
}

export function UnitEconomics({ snap, observed }: { snap: UnitEconomicsSnapshot; observed: ObservedRetention | null }) {
  const defaultMargin = String(Math.round(snap.grossMargin * 100));
  const [marginS, setMargin] = useState(defaultMargin);
  const [attr, setAttr] = useState<Attribution>("likely");
  const [horizon, setHorizon] = useState<number>(DEFAULT_HORIZON);
  const [subSort, setSubSort] = useState<SubSort>("renews");
  // Which month a firm is charged to: the month it started using the product
  // (how the owner reads the table - "we had more than 3 paying in October")
  // or the month its lead came in (what the ad spend actually bought).
  const [basis, setBasis] = useState<Basis>("started");

  const margin = num(marginS, snap.grossMargin * 100) / 100;
  const paidSet = PAID[attr];

  // The retention curve is the measured average of the subscription cohorts
  // (table below), flat at its last value after the last observed month - no
  // presets, no scenarios. With no subscriber cohort yet there is nothing to
  // measure, so firms are assumed to keep paying.
  const s = observed ? observedSurvival(observed, horizon) : Array<number>(horizon).fill(1);

  /** Fully loaded CAC is BLENDED: Meta spend + the FlyTech retainer + the sales
   * team, over every PAYING customer (plan or per-case) whatever its source
   * (owner, 2026-10-28: a referral or conference win "should dilute the ad cost
   * per customer"; conferences and tooling are minimal, referrals unpaid, so
   * those three ARE the acquisition bill). `channelCac` is the secondary
   * figure - Meta spend + agency over the firms the ads produced - which says
   * whether the ads themselves work. A signup that has never sent a case is
   * counted but costs nothing to acquire yet. LTV and payback run on what the
   * cohort actually bills a month - the billed plan for subscribers, the
   * per-case run rate for transactional firms - not a list price. */
  const economics = (spend: number, agency: number, team: number, custs: typeof snap.customers) => {
    const paying = custs.filter((x) => x.kind !== "signup");
    const paid = paying.filter((x) => paidSet.includes(x.source)).length;
    const n = paying.length;
    const adCac = n > 0 ? spend / n : Infinity;
    const agencyCac = n > 0 ? agency / n : Infinity;
    const teamCac = n > 0 ? team / n : Infinity;
    const cac = adCac + agencyCac + teamCac;
    const channelCac = paid > 0 ? (spend + agency) / paid : Infinity;
    const plan = paying.length ? paying.reduce((a, x) => a + x.monthly, 0) / paying.length : 0;
    const contribution = plan * margin;
    const ltv = value(contribution, s, horizon);
    const kinds = {
      signup: custs.filter((x) => x.kind === "signup").length,
      transactional: custs.filter((x) => x.kind === "transactional").length,
      subscription: custs.filter((x) => x.kind === "subscription").length,
    };
    return { paid, paying: n, kinds, adCac, agencyCac, teamCac, cac, channelCac, plan, contribution, ltv, payback: payback(cac, contribution, s) };
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
    return { ...m, custs, fromLeads, arrived, ...economics(m.spend, m.agencyCost, m.teamCost, custs) };
  });
  const totalSpend = cohorts.reduce((a, c) => a + c.spend, 0);
  const totalAgency = cohorts.reduce((a, c) => a + c.agencyCost, 0);
  const totalTeam = cohorts.reduce((a, c) => a + c.teamCost, 0);
  const allCusts = basis === "started" ? startedEra : era;
  const total = economics(totalSpend, totalAgency, totalTeam, allCusts);
  const monthCols = observed?.average.length ?? 0;
  const retentionHeaders: Column[] = [
    left("Cohort"), right("Firms"), ...Array.from({ length: monthCols }, (_, m) => right(`M${m}`)),
  ];
  const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);
  const paidMonths = s.reduce((a, x) => a + x, 0);

  if (!Number.isFinite(total.cac)) {
    return (
      <Card>
        <Empty>No firm is paying yet, so there is no CAC to pay back.</Empty>
      </Card>
    );
  }

  const totalLeads = cohorts.reduce((a, c) => a + (c.adLeads ?? 0), 0);
  const cohortRows = [...cohorts.map((c) => ({ ...c, name: c.label + (c.mature ? "" : " · still converting") })),
    { name: "All months", spend: totalSpend, agencyCost: totalAgency, teamCost: totalTeam, custs: allCusts, fromLeads: era, arrived: startedEra,
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
      <StatGrid cols={4}>
        <Stat label="CAC, fully loaded" value={usd(total.cac)} tone="warn"
          sub={`${usd(total.adCac)} Meta ads + ${usd(total.agencyCac)} FlyTech + ${usd(total.teamCac)} sales & CS salaries, over every paying firm`
            + (Number.isFinite(total.channelCac) ? ` · Meta channel CAC ${usd(total.channelCac)} (${total.paid} firms from ads)` : "")} />
        <Stat label={`LTV, fully loaded · ${horizon} months`} value={usd(total.ltv)}
          sub={`${usd(total.plan)}/mo average per paying firm · ${Math.round(margin * 100)}% margin · ${paidMonths.toFixed(1)} paid months of ${horizon}`} />
        <Stat label="LTV : CAC" value={ratio(total.ltv, total.cac)}
          tone={total.ltv / total.cac >= 3 ? "good" : "bad"}
          sub={`${allCusts.length} firms since July: ${kindsText(total.kinds)}`} />
        <Stat label="Payback" value={mo(total.payback)} tone={total.payback <= 12 ? "good" : "bad"}
          sub={`${usd(total.contribution)}/mo margin per paying firm`} />
      </StatGrid>

      <Card>
        <CardHeader title={basis === "started" ? "Unit economics by month started" : "Unit economics by lead month"}
          action={
            <label className="flex items-center gap-2">
              <span>Measured retention · {ATTR_LABEL[attr]}</span>
              <select className={selectCls} value={basis} onChange={(e) => setBasis(e.target.value as Basis)}>
                <option value="started">Count firms by month they started</option>
                <option value="lead">Count firms by month their lead came in</option>
              </select>
            </label>
          } />
        <Table
          dense
          strongLast
          headers={COHORT_HEADERS}
          rows={cohortRows.map((c) => [
            <Cell key="m" sub={"mature" in c && !c.mature ? "still converting" : undefined}>
              {"label" in c ? c.label : c.name}
            </Cell>,
            <Cell key="f" sub={kindsText(kindCount(c.arrived))}>
              <span className="text-base font-semibold">{c.arrived.length}</span>
            </Cell>,
            <Cell key="s" sub={[
              `${usd(c.spend)} ads${c.spendSource !== "meta" ? (c.spendSource === "planned" ? " (planned)" : " (typed)") : ""}`,
              c.agencyCost ? `+ ${usd(c.agencyCost)} FlyTech` : null,
            ].filter(Boolean).join(" ")}>
              {usd(c.spend + c.agencyCost)}
            </Cell>,
            <Cell key="cpl" sub={c.adLeads ? `${c.adLeads} leads` : undefined}>
              {c.adLeads ? usd((c.spend + c.agencyCost) / c.adLeads) : "—"}
            </Cell>,
            <Cell key="p" sub={`${c.paid} from ads`}>{c.paying}</Cell>,
            usd(c.cac),
            c.paying ? usd(c.plan) : "—",
            usd(c.ltv),
            <Cell key="r" className={clsx(
              Number.isFinite(c.ltv / c.cac) && (c.ltv / c.cac >= 3 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"))}>
              {ratio(c.ltv, c.cac)}
            </Cell>,
            mo(c.payback),
          ])}
        />
        <Note>
          Firms signed up = every firm that started using the product that month (first app signup, first case or
          plan), whether on a plan, paying per case, or signed up with no case yet.
          {basis === "started"
            ? " CAC and LTV run on those firms; a month's ad spend is set against firms that started that month even when their lead came in earlier, so the latest month reads high until its leads convert."
            : " CAC and LTV charge each firm to the month its lead came in, so a month's ad spend is set against the firms it actually produced."}
          {" "}CAC, fully loaded = (Meta spend + FlyTech retainer + sales &amp; CS salaries) ÷ all paying firms,
          whatever their source — a referral or conference win dilutes the cost per customer. Conferences and
          tooling are minimal and referrals are unpaid, so that is the whole acquisition bill. &ldquo;From ads&rdquo;
          is reference only, and feeds the Meta channel CAC shown under the headline figure.
          Avg $/mo is what a paying firm bills (plan, or per-case cash run rate); LTV is gross margin on that over
          the measured retention curve below.
          {fromMeta ? " Ad spend is actual from the Meta Ads account." : " Ad spend is the Settings ledger; the Meta spend sync has not run yet."}
        </Note>
      </Card>

      <Card>
        <CardHeader title="Retention the LTV runs on"
          action={observed ? <span>{observed.firms} subscribers · levels off at {Math.round(observed.plateau)}%</span> : null} />
        {observed ? (
          <Table
            dense
            strongLast
            headers={retentionHeaders}
            rows={[
              ...observed.cohorts.map((c) => [
                c.label, String(c.firms), ...c.retention.map((v) => pct(v)),
              ]),
              [
                "Average",
                String(observed.firms),
                ...observed.average.map((v, m) => (
                  <Cell key={m} sub={`${observed.elapsed[m]} firms`}>{pct(v)}</Cell>
                )),
              ],
            ]}
          />
        ) : <Empty>No subscription cohort yet, so retention cannot be measured.</Empty>}
        <Note>
          {observed ? (
            <>
              The subscription cohorts from the retention chart above (a month with no subscriber is skipped). The
              average is firm-weighted: at each month, the share of every subscriber whose cohort has reached it who
              is still on a plan. After month {observed.average.length - 1}, the last observed month, the curve is
              held flat at {Math.round(observed.plateau)}% - the May cohort has sat at 80% since month 1 - rather than
              churning further. A firm therefore pays for {paidMonths.toFixed(1)} of the {horizon}-month LTV horizon,
              worth {usd(total.ltv)} in margin; the horizon is set below. LTV, LTV : CAC and payback above all use
              this curve. The sample is small and the figures will move as cohorts age.
            </>
          ) : "Once a cohort of subscribers exists, its measured retention drives LTV here."}
        </Note>
      </Card>

      <Card>
        <CardHeader title="Every subscriber"
          action={
            <label className="flex items-center gap-2">
              <span>{liveCount} live · {unusedCount} with cases left{dueSoon ? ` · ${dueSoon} renewing within 7 days` : ""}</span>
              <select className={selectCls} value={subSort} onChange={(e) => setSubSort(e.target.value as SubSort)}>
                <option value="renews">Renews soonest</option>
                <option value="left">Most cases left</option>
                <option value="lead">Lead date</option>
                <option value="subscribed">Subscribed date</option>
                <option value="firm">Firm A–Z</option>
              </select>
            </label>
          } />
        <Table
          headers={SUBSCRIBER_HEADERS}
          rows={sortedSubs.map((x) => {
            const soon = x.live && (x.left ?? 0) > 0 && (x.daysToRenewal ?? 99) <= 7;
            return [
              <span key="f" className="font-medium">{x.firm}</span>,
              <Cell key="p" sub={x.note || undefined}>
                {x.live ? x.planName : <span className="text-zinc-400">Cancelled</span>}
              </Cell>,
              `${usd(x.plan)}`,
              day(x.subscribedAt),
              x.periodEnd
                ? <span key="r" className={clsx(soon && "font-semibold text-amber-600 dark:text-amber-400")}>
                    {day(x.periodEnd)}{x.daysToRenewal !== null ? <span className="ml-1 text-xs opacity-70">{x.daysToRenewal <= 0 ? "today" : `${x.daysToRenewal}d`}</span> : null}
                  </span>
                : "—",
              x.casesThisPeriod === null ? "—" : `${x.casesThisPeriod}${x.included !== null ? ` / ${x.included}` : ""}`,
              x.left === null ? "—"
                : <span key="l" className={clsx((x.left ?? 0) > 0 ? "font-semibold text-amber-600 dark:text-amber-400" : "text-zinc-400")}>{x.left}</span>,
              day(x.leadAt),
              <Badge key="s" tone={!x.preSwitch && paidSet.includes(x.source) ? "blue" : "default"}>
                {x.preEra ? "Before plans launched" : x.preSwitch ? "Lead from before July" : SOURCE_LABEL[x.source]}
              </Badge>,
            ];
          })}
        />
        <Note>
          Plan and renewal date from Stripe (synced every 3 hours); cases this period are the firm&apos;s submitted
          cases dated inside the current billing period, against the plan&apos;s allowance (Solo 2, Boutique 5,
          Growth 10). Firms renewing within 7 days with cases left are amber. Blue sources are the ones the
          selected attribution counts as &ldquo;from ads&rdquo; (reference only; CAC spreads spend over every paying firm);
          a plan from before August is listed but belongs to no cohort. Sources come from
          Lead Source on the firm&apos;s converting deal or contacts in HubSpot; correct a firm there.
        </Note>
      </Card>

      <Card>
        <CardBody>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Field label="Attribution">
              <select value={attr} onChange={(e) => setAttr(e.target.value as Attribution)} className={inputCls}>
                {(Object.keys(PAID) as Attribution[]).map((k) => <option key={k} value={k}>{ATTR_LABEL[k]}</option>)}
              </select>
            </Field>
            <NumberInput label="Gross margin (%)" value={marginS} onChange={setMargin}
              hint={`default ${defaultMargin}% from Settings`} />
            <Field label="LTV horizon" hint="retention is flat after month 3, so LTV needs a cut-off">
              <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} className={inputCls}>
                {HORIZONS.map((h) => <option key={h} value={h}>{h} months</option>)}
              </select>
            </Field>
          </div>
        </CardBody>
      </Card>

      <Note className="px-0 pb-0">
        Per-case charges and expert sign-offs on top of plans would shorten payback. The people cost in CAC is the
        sales & CS salary bill in force each month ({usd(snap.teamCost * 12)}/yr now), customer success included
        because the CSM runs demos and owns the book. Ad spend comes from Meta; FlyTech&apos;s retainer
        ({usd(snap.agencyCost)}/mo now), the salary ledger and the margin are set in Settings. Live billed MRR is {usd(snap.liveMrr)} across{" "}
        {snap.activeSubscribers} paying subscribers.
      </Note>
    </div>
  );
}
