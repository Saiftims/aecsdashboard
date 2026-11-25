/** The Finance section of the Executive page: cash, burn and runway as tiles,
 * then an income statement and a cash statement by month. All figures come
 * from lib/finance.ts; this file only lays them out. */
import {
  Callout, Card, CardHeader, Note, Section, Stat, StatGrid, Table, type Column,
} from "@/components/ui";
import { type FinanceMonth, type FinanceResult, type FinanceSummary } from "@/lib/finance";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Statement style: whole dollars, a negative in brackets, nothing as a dash. */
function amt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  const r = Math.round(n);
  if (r === 0) return "-";
  return r < 0 ? `(${(-r).toLocaleString("en-US")})` : r.toLocaleString("en-US");
}

/** "Aug, Sep and Oct" from the month labels the average covers. */
function basisText(labels: string[]): string {
  const short = labels.map((l) => l.split(" ")[0]);
  if (short.length <= 1) return short[0] ?? "";
  return `${short.slice(0, -1).join(", ")} and ${short[short.length - 1]}`;
}

function runwayText(months: number): string {
  if (months >= 36) return `${Math.round(months / 12)} years`;
  return months >= 10 ? `${Math.round(months)} months` : `${months.toFixed(1)} months`;
}

function monthColumns(months: FinanceMonth[]): Column[] {
  return [
    { label: "", key: "line" },
    ...months.map((m): Column => ({
      label: m.partial ? `${m.label} to date` : m.label, align: "right", key: String(m.index),
    })),
  ];
}

const BOLD = "font-semibold";
const MUTED = "text-zinc-500 dark:text-zinc-400";

function Tiles({ s }: { s: FinanceSummary }) {
  const basis = s.burnBasis.length ? `avg of ${basisText(s.burnBasis)}` : "no complete month yet";
  const notBurning = s.netBurn !== null && s.netBurn <= 0;
  // The latest complete month beside each average: an average of three months
  // hides a spend that has stepped up in the last one.
  const last = s.burnBasis.length ? s.months.filter((m) => !m.partial).at(-1) : undefined;
  const lastName = last?.label.split(" ")[0];
  const lastGross = last ? ` · ${lastName} ${usd(last.expenses)}` : "";
  const lastNet = last && last.netIncome !== null
    ? ` · ${lastName} ${last.netIncome > 0 ? `+${usd(last.netIncome)}` : usd(-last.netIncome)}` : "";
  return (
    <StatGrid cols={4}>
      <Stat
        label="Cash in bank"
        value={usd(s.cash)}
        sub={s.accounts.length > 1 ? `Mercury, ${s.accounts.length} accounts, live` : "Mercury, live"}
      />
      <Stat
        label="Gross burn / month"
        value={s.grossBurn === null ? "-" : usd(s.grossBurn)}
        sub={`${basis}${lastGross}`}
      />
      <Stat
        label="Net burn / month"
        value={s.netBurn === null ? "-" : notBurning ? `+${usd(-s.netBurn)}` : usd(s.netBurn)}
        tone={notBurning ? "good" : undefined}
        sub={s.netBurn === null
          ? "needs Stripe revenue"
          : `${notBurning ? "revenue covers spend" : "spend less gross revenue"}${lastNet}`}
      />
      <Stat
        label="Runway"
        value={s.runwayMonths === null ? (notBurning ? "Not burning" : "-") : runwayText(s.runwayMonths)}
        tone={s.runwayMonths === null
          ? (notBurning ? "good" : undefined)
          : s.runwayMonths < 6 ? "bad" : s.runwayMonths < 12 ? "warn" : "good"}
        sub={s.cashOut ? `cash lasts to about ${s.cashOut}` : "cash divided by net burn"}
      />
    </StatGrid>
  );
}

function IncomeStatement({ s }: { s: FinanceSummary }) {
  const rows: React.ReactNode[][] = [
    ["Revenue (Stripe, gross)", ...s.months.map((m) => amt(m.revenue))],
    ...s.categories.map((c) => [c, ...s.months.map((m) => amt(m.byCategory[c]))]),
    ["Total expenses", ...s.months.map((m) => amt(m.expenses))],
    ["Net income (loss)", ...s.months.map((m) => amt(m.netIncome))],
    ["Memo: revenue later refunded", ...s.months.map((m) => amt(m.refunded))],
  ];
  const total = 1 + s.categories.length;
  const uncategorizedPct = s.totalExpenses > 0
    ? Math.round((s.uncategorized / s.totalExpenses) * 100) : 0;
  return (
    <Card>
      <CardHeader title="Income statement" description="Revenue from Stripe, expenses from Mercury" />
      <Table
        headers={monthColumns(s.months)}
        rows={rows}
        rowClassName={(i) =>
          i === 0 || i === total || i === total + 1 ? BOLD : i === total + 2 ? MUTED : undefined}
      />
      <Note>
        Revenue is every Stripe charge in the month, gross: refunds are not
        deducted, and the memo line shows how much of it was later refunded.
        Expenses are the payments that left Mercury, under the category each
        carries in Mercury.
        {uncategorizedPct > 0
          ? ` ${uncategorizedPct}% of the spend shown has no category there; set one in Mercury and it moves to its own line here.`
          : ""}
        {" "}A card paid off from Mercury is one payment, not what was bought
        on it.
      </Note>
    </Card>
  );
}

function CashStatement({ s }: { s: FinanceSummary }) {
  const rows: React.ReactNode[][] = [
    ["Opening cash", ...s.months.map((m) => amt(m.openingCash))],
    ["Stripe payouts received", ...s.months.map((m) => amt(m.stripePayouts))],
    ["Other receipts", ...s.months.map((m) => amt(m.otherReceipts))],
    ["Payments out", ...s.months.map((m) => amt(-m.expenses))],
    ["Transfers from own accounts", ...s.months.map((m) => amt(m.transfers))],
    ["Closing cash", ...s.months.map((m) => amt(m.closingCash))],
  ];
  return (
    <Card>
      <CardHeader title="Cash" description="What moved through Mercury" />
      <Table
        headers={monthColumns(s.months)}
        rows={rows}
        rowClassName={(i) => (i === 0 || i === rows.length - 1 ? BOLD : undefined)}
      />
      <Note>
        Transfers are money moved between the company&apos;s own accounts
        {s.transferSources.length ? ` (from ${s.transferSources.join(", ")})` : ""}
        , so they count as neither income nor spend. Stripe pays out after
        refunds and its fees, a few days behind, so payouts will not match the
        revenue line above. Other receipts are in this table only: they are not
        counted as revenue and do not reduce burn. Cash held in, or bills paid
        from, any other bank account is not in these figures.
      </Note>
    </Card>
  );
}

export function Finance({ result }: { result: FinanceResult }) {
  if (result.status === "off") return null;
  if (result.status === "error") {
    return (
      <Section title="Finance">
        <Callout tone="warn" title="Mercury could not be read just now">
          Cash, burn and runway are read live from the bank and it did not
          answer; reload to try again. ({result.message.slice(0, 160)})
        </Callout>
      </Section>
    );
  }
  const s = result.summary;
  return (
    <Section
      title="Finance"
      description="Cash and spend from Mercury; revenue is gross Stripe charges, before refunds. Executives only."
    >
      <div className="space-y-4">
        <Tiles s={s} />
        <IncomeStatement s={s} />
        <CashStatement s={s} />
      </div>
    </Section>
  );
}
