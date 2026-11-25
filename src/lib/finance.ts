/** Cash, burn, runway and two very high level statements for the Executive page.
 *
 * Two sources, each used for the one thing it knows:
 *
 *  - REVENUE IS STRIPE, GROSS. Every charge in the month, refunds not deducted
 *    (owner, 2026-11-25: "use gross revenue figures from stripe before
 *    refunds") - the same figure as every other revenue number on the
 *    dashboard, see lib/revenue.ts. The bank cannot state revenue: Stripe pays
 *    out net of refunds and fees, days later, and until 2026-10-26 it did not
 *    pay into Mercury at all.
 *
 *  - CASH AND SPEND ARE MERCURY. The balance, and every payment that left the
 *    account, grouped by the category the transaction carries in Mercury.
 *
 * Net burn is spend less revenue, so it is the income statement's loss with
 * the sign turned round, and runway is cash divided by its recent average.
 *
 * MONEY MOVED BETWEEN THE COMPANY'S OWN ACCOUNTS IS NEITHER. As of 2026-11-25,
 * $516k of the $548k that had ever arrived in Mercury was transferred in from
 * a Chase account; read as income it would show the company profitable in the
 * months it was funded. Transfers get their own line in the cash statement and stay
 * out of revenue, spend and burn.
 *
 * What this cannot see: money held in, or bills paid from, any other bank or
 * card. A card paid off from Mercury shows as one payment, not as what was
 * bought on it.
 */
import {
  listAccounts, listTransactions, mercuryConfigured,
} from "@/lib/mercury/client";
import { loadRevenueFacts, monthIndexOf } from "@/lib/revenue";

/** Spend with no category set on it in Mercury. */
export const UNCATEGORIZED = "Uncategorized";

export interface BankTxn {
  /** Dollars; negative is money out. */
  amount: number;
  /** When the money moved. */
  at: string;
  /** Mercury's transaction kind. */
  kind: string | null;
  counterparty: string | null;
  description: string | null;
  /** The category set on the transaction in Mercury, if any. */
  category: string | null;
}

export type Flow = "transfer" | "stripe_payout" | "other_receipt" | "expense";

/** Mercury's kinds for money moving between accounts the company owns: to or
 * from a linked account at another bank, between its Mercury accounts, or in
 * and out of Mercury Treasury. */
const TRANSFER_KINDS: ReadonlySet<string> = new Set([
  "externalTransfer", "internalTransfer", "treasuryTransfer",
]);

/** What a bank transaction is, for the statements.
 *
 * A receipt that is not a Stripe payout (a vendor's refund, a customer's wire,
 * an investor's) is reported in the cash statement only. It is not revenue,
 * because revenue is Stripe's to state, and it does not reduce burn, so a
 * funding wire can never make the company look as if it has stopped burning. */
export function flowOf(t: Pick<BankTxn, "amount" | "kind" | "counterparty" | "description">): Flow {
  if (TRANSFER_KINDS.has(t.kind ?? "")) return "transfer";
  // Either sign: a payout Stripe claws back nets against the ones it paid.
  if (/\bstripe\b/i.test(`${t.counterparty ?? ""} ${t.description ?? ""}`)) return "stripe_payout";
  return t.amount > 0 ? "other_receipt" : "expense";
}

export interface FinanceMonth {
  /** year*12 + month, UTC - the same index lib/revenue.ts uses. */
  index: number;
  /** "Nov 2026" */
  label: string;
  /** The current month, still running. Never part of a burn average. */
  partial: boolean;
  /** Stripe charges, gross. Null when Stripe has never synced. */
  revenue: number | null;
  /** How much of `revenue` was later refunded. Shown, not deducted. */
  refunded: number | null;
  /** Payments out of Mercury, as a positive number. */
  expenses: number;
  byCategory: Record<string, number>;
  /** revenue - expenses. */
  netIncome: number | null;
  openingCash: number;
  stripePayouts: number;
  otherReceipts: number;
  /** Net money moved in from (positive) or out to the company's other accounts. */
  transfers: number;
  closingCash: number;
}

export interface FinanceSummary {
  /** Dollars across every Mercury account, posted. */
  cash: number;
  accounts: { name: string; balance: number }[];
  /** Oldest first, ending with the current month. */
  months: FinanceMonth[];
  /** Expense categories across `months`, largest first, Uncategorized last. */
  categories: string[];
  /** Labels of the complete months the burn figures average. */
  burnBasis: string[];
  /** Average monthly spend. Null with no complete month to measure. */
  grossBurn: number | null;
  /** Average monthly spend less revenue. Zero or below is not burning. */
  netBurn: number | null;
  /** Cash divided by net burn. Null when not burning or not measurable. */
  runwayMonths: number | null;
  /** "Mar 2028": the month cash reaches zero at this rate. */
  cashOut: string | null;
  /** Who the transfers in came from, so the reader knows what "own accounts" means. */
  transferSources: string[];
  /** Spend in `months` that has no category in Mercury. */
  uncategorized: number;
  /** Spend in `months`, the denominator for `uncategorized`. */
  totalExpenses: number;
}

export interface RevenueByMonth {
  /** False when Stripe has never synced: revenue is unknown, not zero. */
  ready: boolean;
  byMonth: Map<number, number>;
  refundedByMonth: Map<number, number>;
}

const cents = (n: number) => Math.round(n * 100) / 100;

export function monthLabel(index: number): string {
  return new Date(Date.UTC(Math.floor(index / 12), index % 12, 1))
    .toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** The statements, from data already in hand. Pure: everything it needs is an
 * argument, so it is the part the tests exercise. */
export function buildFinance({
  accounts, txns, revenue, now = new Date(), months = 6,
}: {
  accounts: { name: string; balance: number }[];
  txns: BankTxn[];
  revenue: RevenueByMonth;
  now?: Date;
  /** How many calendar months to show, the current one included. */
  months?: number;
}): FinanceSummary {
  const cash = cents(accounts.reduce((s, a) => s + a.balance, 0));
  const nowIdx = monthIndexOf(now.toISOString())!;

  type Agg = { payouts: number; other: number; transfers: number; expenses: number; byCategory: Record<string, number> };
  const blank = (): Agg => ({ payouts: 0, other: 0, transfers: 0, expenses: 0, byCategory: {} });
  const agg = new Map<number, Agg>();
  const transferSources = new Set<string>();
  for (const t of txns) {
    const i = monthIndexOf(t.at);
    if (i === null || i > nowIdx || !t.amount) continue;
    const a = agg.get(i) ?? blank();
    agg.set(i, a);
    const flow = flowOf(t);
    if (flow === "transfer") {
      a.transfers += t.amount;
      if (t.amount > 0 && t.counterparty) transferSources.add(t.counterparty);
    } else if (flow === "stripe_payout") {
      a.payouts += t.amount;
    } else if (flow === "other_receipt") {
      a.other += t.amount;
    } else {
      const category = t.category?.trim() || UNCATEGORIZED;
      a.expenses -= t.amount;
      a.byCategory[category] = (a.byCategory[category] ?? 0) - t.amount;
    }
  }

  // Open on the first month in the window where something happened: a column
  // of dashes ahead of it says nothing. "Something" is a dollar or more moving
  // through the bank, or any Stripe revenue - the pennies a provider deposits
  // and takes back to verify the account (Intuit, June 2026) do not count.
  const quiet = (i: number) => {
    const a = agg.get(i);
    const moved = a ? Math.abs(a.payouts) + Math.abs(a.other) + Math.abs(a.transfers) + a.expenses : 0;
    return moved < 1 && !(revenue.ready && (revenue.byMonth.get(i) ?? 0) > 0);
  };
  let start = nowIdx - months + 1;
  while (start < nowIdx && quiet(start)) start += 1;

  // Month-end balances are walked BACK from the balance Mercury reports today
  // rather than added up from zero, so the newest figure is always the bank's
  // own and any gap in the history lands in the oldest opening balance.
  const out: FinanceMonth[] = [];
  let closing = cash;
  for (let i = nowIdx; i >= start; i -= 1) {
    const a = agg.get(i) ?? blank();
    const opening = closing - (a.payouts + a.other + a.transfers - a.expenses);
    const rev = revenue.ready ? revenue.byMonth.get(i) ?? 0 : null;
    out.unshift({
      index: i,
      label: monthLabel(i),
      partial: i === nowIdx,
      revenue: rev === null ? null : cents(rev),
      refunded: revenue.ready ? cents(revenue.refundedByMonth.get(i) ?? 0) : null,
      expenses: cents(a.expenses),
      byCategory: Object.fromEntries(
        Object.entries(a.byCategory).map(([k, v]) => [k, cents(v)])),
      netIncome: rev === null ? null : cents(rev - a.expenses),
      openingCash: cents(opening),
      stripePayouts: cents(a.payouts),
      otherReceipts: cents(a.other),
      transfers: cents(a.transfers),
      closingCash: cents(closing),
    });
    closing = opening;
  }

  const categoryTotals = new Map<string, number>();
  for (const m of out) {
    for (const [k, v] of Object.entries(m.byCategory)) {
      categoryTotals.set(k, (categoryTotals.get(k) ?? 0) + v);
    }
  }
  const categories = [...categoryTotals.entries()]
    .sort((a, b) =>
      Number(a[0] === UNCATEGORIZED) - Number(b[0] === UNCATEGORIZED) || b[1] - a[1])
    .map(([k]) => k);

  // Burn is averaged over the last three COMPLETE months. The current month
  // is left out (a month three days old has barely spent anything), and so is
  // any month before the account's first payment (it was not operating yet).
  const complete = out.filter((m) => !m.partial);
  const firstSpend = complete.findIndex((m) => m.expenses > 0);
  const basis = firstSpend < 0 ? [] : complete.slice(firstSpend).slice(-3);
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const grossBurn = basis.length ? cents(mean(basis.map((m) => m.expenses))) : null;
  const netBurn = basis.length && revenue.ready
    ? cents(mean(basis.map((m) => m.expenses - (m.revenue ?? 0)))) : null;
  const runwayMonths = netBurn !== null && netBurn > 0 ? cash / netBurn : null;
  // Past ten years the date is noise.
  const cashOut = runwayMonths !== null && runwayMonths < 120
    ? new Date(now.getTime() + runwayMonths * 30.4375 * 86_400_000)
      .toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
    : null;

  return {
    cash,
    accounts,
    months: out,
    categories,
    burnBasis: basis.map((m) => m.label),
    grossBurn,
    netBurn,
    runwayMonths,
    cashOut,
    transferSources: [...transferSources].sort(),
    uncategorized: cents(categoryTotals.get(UNCATEGORIZED) ?? 0),
    totalExpenses: cents(out.reduce((s, m) => s + m.expenses, 0)),
  };
}

export type FinanceResult =
  | { status: "ok"; summary: FinanceSummary }
  /** No Mercury token configured: there is nothing to show. */
  | { status: "off" }
  /** Mercury did not answer. The rest of the page must still render. */
  | { status: "error"; message: string };

/** Read Mercury live and Stripe revenue from the cache, and build the
 * statements. Never throws: a bank outage is reported, not propagated. */
export async function financeSummary(now = new Date()): Promise<FinanceResult> {
  if (!mercuryConfigured()) return { status: "off" };
  try {
    // Stripe failing is not a reason to hide the bank balance: revenue then
    // reads as unknown and the cash side still shows.
    const [accounts, facts] = await Promise.all([
      listAccounts(),
      loadRevenueFacts().catch(() => null),
    ]);
    const ledgers = await Promise.all(accounts.map((a) => listTransactions(a.id)));

    const txns: BankTxn[] = ledgers.flat()
      // Only `sent` has moved the balance; pending, failed and cancelled have not.
      .filter((t) => t.status === "sent" && (t.postedAt ?? t.createdAt))
      .map((t) => ({
        amount: t.amount ?? 0,
        at: (t.postedAt ?? t.createdAt)!,
        kind: t.kind ?? null,
        counterparty: t.counterpartyName ?? null,
        description: t.bankDescription ?? null,
        category: t.categoryData?.name ?? null,
      }));

    const refundedByMonth = new Map<number, number>();
    for (const p of facts?.payments ?? []) {
      const i = monthIndexOf(p.at);
      if (i !== null && p.refunded) refundedByMonth.set(i, (refundedByMonth.get(i) ?? 0) + p.refunded);
    }

    return {
      status: "ok",
      summary: buildFinance({
        accounts: accounts.map((a) => ({
          name: a.name ?? a.kind ?? "Account", balance: a.currentBalance ?? 0,
        })),
        txns,
        revenue: {
          ready: Boolean(facts?.ready),
          byMonth: facts?.byMonth ?? new Map(),
          refundedByMonth,
        },
        now,
      }),
    };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
