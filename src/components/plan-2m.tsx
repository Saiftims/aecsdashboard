"use client";

/** Shareable "Path to $2M annualized revenue by June" plan. Self-contained:
 * all numbers come from src/lib/plan-2m.ts (a Nov 17 snapshot), the custom
 * scenario is recomputed in the browser. Rendered at /share/plan-2m. */
import { useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis, LabelList,
} from "recharts";
import {
  ACT, ACTIVE_SUBS, HIRES, MONTHS_ACTUAL, MRR, NOV_PROJECTED_REVENUE, PLAN_MONTHS, SCENARIOS,
  TARGET_ARR, TARGET_MRR, UNIT, hitMonth, kfmt as k, mfmt as m, money, pct, r0, simulate,
  type MonthResult, type Scenario,
} from "@/lib/plan-2m";
import { Callout, Card, CardBody, CardHeader, Field, Stat, Table, inputCls } from "@/components/ui";

const COLOURS = {
  A: "hsl(var(--chart-6))",
  B: "hsl(var(--chart-1))",
  C: "hsl(var(--chart-2))",
  custom: "hsl(var(--chart-3))",
  text: "hsl(var(--chart-text))",
  grid: "hsl(var(--chart-grid))",
};
const RIGHT = { align: "right" as const };
const rightCols = (first: string, rest: string[]) => [first, ...rest.map((label) => ({ label, ...RIGHT }))];

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{children}</h2>;
}
function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{children}</h3>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{children}</p>;
}
function Caption({ children }: { children: React.ReactNode }) {
  return <p className="text-xs leading-relaxed text-zinc-400 dark:text-zinc-500">{children}</p>;
}
function Pill({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "good" }) {
  return (
    <span className={
      tone === "good"
        ? "rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
        : "rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
    }>
      {children}
    </span>
  );
}

export function Plan2M() {
  const [aes, setAes] = useState("2");
  const [aeFirst, setAeFirst] = useState("1");
  const [bdrs, setBdrs] = useState("2");
  const [meta, setMeta] = useState("35000");
  const [cs, setCs] = useState(true);
  const [arpaG, setArpaG] = useState("2.5");
  const [churn, setChurn] = useState("1");

  const num = (v: string, d: number) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
  const custom: Scenario = {
    name: "Custom",
    aeStarts: Array.from({ length: Math.max(0, Math.min(4, Math.round(num(aes, 0)))) }, (_, i) => Math.max(0, Math.round(num(aeFirst, 1))) + i),
    bdrStarts: Array.from({ length: Math.max(0, Math.min(4, Math.round(num(bdrs, 0)))) }, (_, i) => i),
    metaSpend: Math.max(0, num(meta, UNIT.baseMetaSpend)),
    csManagerStart: cs ? 0 : null,
    arpaGrowth: num(arpaG, 1) / 100,
    churn: Math.max(0, num(churn, 1)) / 100,
  };

  const results = SCENARIOS.map(simulate);
  const customResult = simulate(custom);
  const june = (r: MonthResult[]) => r[r.length - 1];
  const novArr = NOV_PROJECTED_REVENUE * 12;
  const cJune = june(results[2]);
  const totalOte = HIRES.reduce((n, h) => n + h.ote, 0);
  const metaAnnual = 35000 * 7;

  const arrChart = PLAN_MONTHS.map((month, i) => ({
    month,
    A: Math.round(results[0][i].arr / 1000),
    B: Math.round(results[1][i].arr / 1000),
    C: Math.round(results[2][i].arr / 1000),
    Custom: Math.round(customResult[i].arr / 1000),
  }));
  const firmsChart = results[2].map((x) => ({ month: x.month, "New firms / mo": Math.round(x.wins), "Paying firms": Math.round(x.firms) }));
  const demandChart = results[2].map((x) => ({ month: x.month, "MQLs / mo": Math.round(x.mqls), "Demos / mo": Math.round(x.demos) }));

  const tick = { fontSize: 11, fill: COLOURS.text };
  const tooltipStyle = { fontSize: 12, borderRadius: 8 };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-8">
      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wider text-zinc-500">Silent Witness · GTM plan · Nov 17, 2026</div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 md:text-3xl">Path to $2M annualized revenue by June 2027</h1>
        <p className="mt-2 max-w-3xl text-sm text-zinc-500 dark:text-zinc-400">
          Where Silent Witness lands with the current team versus with new hires. Every input is taken from HubSpot, Stripe, Meta and the app as of Nov 17;
          the model runs Dec → Jun month by month.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Annualized run-rate (Nov projected)" value={m(novArr)} />
        <Stat label="Target by June" value={m(TARGET_ARR)} tone="good" />
        <Stat label="Multiple required" value={`${(TARGET_ARR / novArr).toFixed(1)}×`} tone="warn" />
        <Stat label="Monthly revenue needed in June" value={k(TARGET_MRR)} />
      </div>

      <Callout tone="info" title="The short answer">
        Current momentum (Chris alone, $15k/mo on Meta, churn as today) ends June at about <b>{m(june(results[0]).arr)}</b>. Adding one BDR and one AE with a CS manager
        (Scenario B) gets to <b>{m(june(results[1]).arr)}</b> — on the line, with no margin for a soft month. Scenario C makes $2M safe: a CS manager now,{" "}
        <b>2 BDRs and 2 AEs</b> hired Dec–Feb, Meta scaled to ~$35k/mo, and a deliberate push from Solo ($300) to Boutique/Growth plans. C crosses $2M in{" "}
        <b>{hitMonth(results[2])}</b> and ends June at <b>{m(cJune.arr)}</b>. In June that means ~{r0(cJune.mqls)} MQLs, ~{r0(cJune.demos)} demos, ~{r0(cJune.wins)} new firms and ~{r0(cJune.cases)} cases a month.
      </Callout>

      <section className="flex flex-col gap-2">
        <H2>Where we are: Jul–Nov actuals</H2>
        <Card>
          <Table
            headers={rightCols("Metric", MONTHS_ACTUAL)}
            rows={[
              ["Meta spend", ...ACT.metaSpend.map((v) => k(v))],
              ["Meta leads", ...ACT.metaLeads.map(String)],
              ["MQLs (deals created)", ...ACT.dealsCreated.map(String)],
              ["Demos held", ...ACT.demos.map(String)],
              ["New firms (closed won)", ...ACT.closedWon.map(String)],
              ["Firms charged in month", ...ACT.payingFirms.map(String)],
            ["Customers to date (ever paid)", ...ACT.customersToDate.map(String)],
              ["Cases submitted", ...ACT.cases.map(String)],
              ["Gross revenue (Stripe)", ...ACT.revenue.map((v) => money(v))],
            ]}
          />
        </Card>
        <Caption>* Nov = 1st–17th. Nov gross revenue projects to ~$28k (+33% vs Oct). Revenue is gross Stripe charges before refunds (subscriptions + per-case), external customers only. Source: HubSpot deals/demos, Stripe, app cases, Meta Ads.</Caption>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Unit economics the model uses" />
          <Table
            dense
            headers={["Driver", "Value", "Basis"]}
            rows={[
              ["Meta budget (base case)", "$15k / mo", "Committed spend going forward; Scenarios B and C raise it to $20k and $35k"],
              ["Cost per Meta lead", money(UNIT.cpl), "Oct $81, Nov $68; drifts +$8 per extra $10k/mo spend"],
              ["Organic MQLs / month", String(UNIT.organicMqls), "Deals with no Meta source, Sep–Nov"],
              ["MQL → demo", pct(UNIT.mqlToDemo), "Jul 37%, Aug 59%, Sep 43%, Oct 23%"],
              ["Demo → closed won", pct(UNIT.demoToWon), "Jul 37%, Aug 34%, Sep 39%, Oct 21% (cohort still open)"],
              ["Demos per AE / month", String(UNIT.demosPerAe), "Chris: 70 in Oct, 71 in Nov 1–17"],
              ["Gross revenue per paying firm / month", money(UNIT.arpa), "Sep $496, Oct $466 (subscription + per-case); 46 of 63 subs are $300 Solo"],
                ["Paying firms today", "60 / 84", "60 charged since Oct 1; 84 customers have paid at least once; 63 active subscriptions"],
              ["Cases per paying firm / month", UNIT.casesPerFirm.toFixed(1), "Sep 2.0, Oct 2.0"],
              ["Monthly logo churn", "1%", "2 cancellations in 5.5 months (Paronyan Oct, Farsad Nov) on an avg ~40 subs; pauses/failed cards not counted"],
            ]}
          />
        </Card>
        <Card>
          <CardHeader title="What the funnel says about bottlenecks" />
          <CardBody className="flex flex-col gap-3">
            <P>
              <b>Closing capacity is the constraint, not leads.</b> October produced 277 MQLs but only 65 got a demo; Chris ran 173 of the 179 demos since
              September and closed 67 of 71 deals. One person is the entire pipeline.
            </P>
            <P>
              <b>Price point is low.</b> 46 of 63 active subscriptions are $300 Solo. Gross revenue per paying firm is ~$465/mo including per-case fees. Firms on Filevine (22) and
              Litify/Needles (9) are the larger accounts to move to Boutique/Growth.
            </P>
            <P>
              <b>Churn is near zero.</b> Only Paronyan and Farsad have cancelled since June (~1%/mo). The CS hire is therefore an expansion role — cases per
              firm, Solo → Boutique/Growth upgrades, and reactivating paused accounts — not a retention firefight.
            </P>
          </CardBody>
        </Card>
      </div>

      <section className="flex flex-col gap-2">
        <H2>Annualized revenue by month, Dec → Jun</H2>
        <Card>
          <CardBody>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={arrChart} margin={{ top: 10, right: 24, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={COLOURS.grid} />
                <XAxis dataKey="month" tick={tick} />
                <YAxis tick={tick} tickFormatter={(v) => `$${v}k`} width={60} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v) => `$${Number(v).toLocaleString()}k`} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <ReferenceLine y={TARGET_ARR / 1000} stroke={COLOURS.C} strokeDasharray="4 4" label={{ value: "$2M target", position: "insideTopLeft", fontSize: 11, fill: COLOURS.C }} />
                <Line type="monotone" dataKey="A" name={SCENARIOS[0].name} stroke={COLOURS.A} strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="B" name={SCENARIOS[1].name} stroke={COLOURS.B} strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="C" name={SCENARIOS[2].name} stroke={COLOURS.C} strokeWidth={2.5} dot={false} />
                <Line type="monotone" dataKey="Custom" name="Custom" stroke={COLOURS.custom} strokeWidth={2} strokeDasharray="5 3" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardBody>
        </Card>
        <Caption>Annualized revenue = monthly collected revenue × 12, in $k. Series: scenarios A, B, C and the custom scenario from the controls below.</Caption>
      </section>

      <section className="flex flex-col gap-2">
        <H3>June 2027 outcome by scenario</H3>
        <Card>
          <Table
            dense
            headers={[
              "Scenario", "Hires",
              ...["Meta / mo", "MQLs / mo", "Demos / mo", "New firms / mo", "Paying firms", "Rev / firm", "Cases / mo", "Revenue / mo", "Annualized"].map((label) => ({ label, ...RIGHT })),
              "Crosses $2M",
            ]}
            rowClassName={(i) => (i === 2 ? "bg-emerald-50/60 font-medium dark:bg-emerald-950/20" : i === 3 ? "bg-amber-50/60 dark:bg-amber-950/20" : undefined)}
            rows={[...results.map((r, i) => [SCENARIOS[i], r] as const), [custom, customResult] as const].map(([s, r]) => {
              const j = june(r);
              return [
                s.name,
                `${s.bdrStarts.length} BDR · ${s.aeStarts.length} AE${s.csManagerStart !== null ? " · CS" : ""}`,
                k(s.metaSpend), r0(j.mqls), r0(j.demos), r0(j.wins), r0(j.firms), money(j.arpa), r0(j.cases), k(j.revenue), m(j.arr), hitMonth(r),
              ];
            })}
          />
        </Card>
        <Caption>Paying firms = firms charged in the month (subscribers plus per-case payers); 84 firms have paid to date. Cases assume 2.0/firm/mo rising to 2.6 with a CS manager. New firms/mo is closed-won deals.</Caption>
      </section>

      <Card>
        <CardHeader title="Custom scenario" description="Change the inputs; the orange line and the Custom row update live." />
        <CardBody className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Field label="New AEs (0–4)"><input className={inputCls} type="number" value={aes} onChange={(e) => setAes(e.target.value)} /></Field>
            <Field label="First AE start (0 = Dec, 1 = Jan …)"><input className={inputCls} type="number" value={aeFirst} onChange={(e) => setAeFirst(e.target.value)} /></Field>
            <Field label="BDRs (0–4, one per month from Dec)"><input className={inputCls} type="number" value={bdrs} onChange={(e) => setBdrs(e.target.value)} /></Field>
            <Field label="Meta spend $/month"><input className={inputCls} type="number" step={1000} value={meta} onChange={(e) => setMeta(e.target.value)} /></Field>
            <Field label="Revenue/firm growth %/month (plan mix)"><input className={inputCls} type="number" step={0.5} value={arpaG} onChange={(e) => setArpaG(e.target.value)} /></Field>
            <Field label="Monthly churn % (cancellations only)"><input className={inputCls} type="number" step={0.5} value={churn} onChange={(e) => setChurn(e.target.value)} /></Field>
            <Field label="CS manager from Dec">
              <label className="flex h-[34px] items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                <input type="checkbox" className="h-4 w-4 accent-zinc-900 dark:accent-zinc-100" checked={cs} onChange={(e) => setCs(e.target.checked)} />
                {cs ? "Yes" : "No"}
              </label>
            </Field>
            <Stat label="Custom · June annualized" value={m(june(customResult).arr)} tone={june(customResult).arr >= TARGET_ARR ? "good" : "warn"} />
          </div>
          <Table
            dense
            headers={rightCols("Month", ["MQLs", "Demo capacity", "Demos", "New firms", "Paying firms", "Rev / firm", "Cases", "Revenue", "Annualized"])}
            rows={customResult.map((x) => [x.month, r0(x.mqls), r0(x.demoCapacity), r0(x.demos), r0(x.wins), r0(x.firms), money(x.arpa), r0(x.cases), k(x.revenue), m(x.arr)])}
          />
        </CardBody>
      </Card>

      <section className="flex flex-col gap-3">
        <H2>Scenario C month by month</H2>
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader title="New firms and paying firms" />
            <CardBody>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={firmsChart} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={COLOURS.grid} vertical={false} />
                  <XAxis dataKey="month" tick={tick} />
                  <YAxis tick={tick} width={40} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="New firms / mo" fill={COLOURS.B} radius={[4, 4, 0, 0]}><LabelList dataKey="New firms / mo" position="top" fontSize={10} fill={COLOURS.text} /></Bar>
                  <Bar dataKey="Paying firms" fill={COLOURS.C} radius={[4, 4, 0, 0]}><LabelList dataKey="Paying firms" position="top" fontSize={10} fill={COLOURS.text} /></Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Demand needed: MQLs and demos" />
            <CardBody>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={demandChart} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={COLOURS.grid} vertical={false} />
                  <XAxis dataKey="month" tick={tick} />
                  <YAxis tick={tick} width={40} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="MQLs / mo" fill={COLOURS.A} radius={[4, 4, 0, 0]}><LabelList dataKey="MQLs / mo" position="top" fontSize={10} fill={COLOURS.text} /></Bar>
                  <Bar dataKey="Demos / mo" fill={COLOURS.B} radius={[4, 4, 0, 0]}><LabelList dataKey="Demos / mo" position="top" fontSize={10} fill={COLOURS.text} /></Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardBody>
          </Card>
        </div>
        <Card>
          <Table
            dense
            headers={rightCols("", PLAN_MONTHS)}
            rows={[
              ["MQLs", ...results[2].map((x) => r0(x.mqls))],
              ["Demos", ...results[2].map((x) => r0(x.demos))],
              ["New firms", ...results[2].map((x) => r0(x.wins))],
              ["Paying firms", ...results[2].map((x) => r0(x.firms))],
              ["Cases", ...results[2].map((x) => r0(x.cases))],
              ["Revenue / firm", ...results[2].map((x) => money(x.arpa))],
              ["Revenue", ...results[2].map((x) => k(x.revenue))],
              ["Annualized", ...results[2].map((x) => m(x.arr))],
            ]}
          />
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <H2>Hiring plan for Scenario C</H2>
        <Card>
          <Table
            headers={["Hire", "Start", { label: "OTE", ...RIGHT }, "Why / target"]}
            rows={HIRES.map((h) => [<span key={h.role} className="font-medium">{h.role}</span>, h.start, money(h.ote), h.why])}
          />
        </Card>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Stat label="Added payroll (annual OTE)" value={money(totalOte)} />
          <Stat label="Meta spend Dec–Jun at $35k/mo" value={money(metaAnnual)} />
          <Stat label="June revenue run-rate vs Nov" value={`${k(cJune.revenue)} vs ${k(NOV_PROJECTED_REVENUE)}`} tone="good" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Pill>Dec: CS manager + BDR #1 start</Pill>
          <Pill>Jan: AE #2 + BDR #2 start, Meta to $25k</Pill>
          <Pill>Feb: AE #3 starts, Meta to $35k</Pill>
          <Pill tone="good">Mar: AE #2 ramped, 150+ demos/mo</Pill>
          <Pill tone="good">May–Jun: $2M crossed</Pill>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="What has to be true" />
          <CardBody className="flex flex-col gap-2">
            <P>1. Win rate holds near 30% as demo volume triples. The Oct cohort is at 21% so far — watch it close out before hiring AE #3.</P>
            <P>2. Meta CPL stays under ~$100 at $35k/mo. Oct ran $81 at $15k; expect degradation, which the model already builds in.</P>
            <P>3. Gross revenue per firm climbs from $465 to ~$600: cases/firm from 2.0 to 2.6, and at least a third of new firms land on Boutique or Growth, not Solo.</P>
            <P>4. Churn stays near today&apos;s ~1%/mo as the base grows 5×. Only 2 firms have cancelled so far; the risk is new Solo firms that never submit a second case.</P>
            <P>5. Delivery scales ~8× on cases (89/mo → ~900/mo). That is an operations plan on its own: analysts, QA, and Dr. Hashish&apos;s sign-off capacity.</P>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Monthly operating targets to track (Scenario C)" />
          <Table
            dense
            headers={rightCols("Metric", ["Now (Nov pace)", "Mar", "Jun"])}
            rows={[
              ["MQLs / month", "~270", r0(results[2][3].mqls), r0(cJune.mqls)],
              ["Demos / month", "~100", r0(results[2][3].demos), r0(cJune.demos)],
              ["New firms / month", "~25", r0(results[2][3].wins), r0(cJune.wins)],
              ["Paying firms / month", String(UNIT.payingFirmsNow), r0(results[2][3].firms), r0(cJune.firms)],
              ["Cases / month", "~85", r0(results[2][3].cases), r0(cJune.cases)],
              ["Revenue / firm / month", money(UNIT.arpa), money(results[2][3].arpa), money(cJune.arpa)],
              ["Revenue / month", k(NOV_PROJECTED_REVENUE), k(results[2][3].revenue), k(cJune.revenue)],
            ]}
          />
        </Card>
      </div>

      <Caption>
        Sources: HubSpot deals (pipeline default, sw_demo_date, closedate), Stripe charges and subscriptions (external customers, gross before refunds), app case submissions,
        Meta Ads spend and leads; all via the GTM dashboard database as of 2026-11-17. Active subscriptions today: {ACTIVE_SUBS} ({money(MRR)} MRR).
      </Caption>
    </div>
  );
}
