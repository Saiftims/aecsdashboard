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
 *
 * META AD SPEND IS AN EXPENSE ONLY FOR MONTHS BEFORE OCTOBER 2026. Meta is
 * billed to a Chase card (owner, 2026-11-25) and Mercury has never paid Meta
 * directly. From 2026-10-29 Mercury pays that card, so the ads' cost is inside
 * the card payments and adding it again would count it twice. Before then the
 * card was paid from somewhere Mercury cannot see, so those months' burn was
 * missing the ads altogether: for them, what Meta itself reports
 * (`meta_ad_spend_daily`) is added as its own expense line (owner,
 * 2026-11-25: "add it for those months"). It never touches the cash
 * statement, because the money did not leave Mercury.
 *
 * A PAYMENT WITH NO CATEGORY IN MERCURY GETS ONE HERE where the ledger itself
 * says what it is - see CATEGORY_RULES (owner, 2026-11-25: "dig into
 * uncategorized and categorize it properly"). A category set in Mercury always
 * wins, and a payee no rule knows stays Uncategorized rather than being
 * guessed at.
 */
import {
  listAccounts, listTransactions, mercuryConfigured,
} from "@/lib/mercury/client";
import { loadRevenueFacts, monthIndexOf } from "@/lib/revenue";
import { selectAll } from "@/lib/supabase/server";

/** Spend with no category in Mercury that no rule below recognises either. */
export const UNCATEGORIZED = "Uncategorized";
/** Mercury's own category name, so rule-matched pay lands on the same line. */
export const PAYROLL = "Payroll";
export const CONTRACTORS = "Contractors & Consulting";
/** Meta's reported spend for a month its card bill was not paid from Mercury. */
export const META_ADS = "Meta ads (not paid from Mercury)";

/** The month Mercury first paid the Chase card Meta is billed to (2026-10-29).
 * From here on the ads are inside the card payments. */
const CARD_PAID_FROM_MERCURY_SINCE = 2026 * 12 + 9;

export interface BankTxn {
  /** Dollars; negative is money out. */
  amount: number;
  /** When the money moved. */
  at: string;
  /** Mercury's transaction kind. */
  kind: string | null;
  counterparty: string | null;
  description: string | null;
  /** The memo sent with the payment. */
  memo: string | null;
  /** The category set on the transaction in Mercury, if any. */
  category: string | null;
}

type Describable = Pick<BankTxn, "counterparty" | "description"> & { memo?: string | null };

/** What an uncategorized payment is, read off the ledger as of 2026-11-25.
 * First match wins. Each rule is here because the transactions say so, not
 * because the name sounds like it:
 *
 *  - Intuit's "PAYROLL" and "TAX" debits are the payroll run and the payroll
 *    tax it remits; the team had already filed half of them under Payroll.
 *  - "Final Pay Pay Period: 7/12/26-7/25/26" is a departing employee's pay.
 *  - Ahmad "Alex" Qoqazeh is the AE (see lib/sync/meta.ts), paid monthly.
 *  - Marwane Ait Si Ahmad: one of his three payments was filed under Payroll.
 *  - "Contractor:Consulting" is the memo Mercury carries on the Ontario Inc
 *    and Apricot Inc payments; the two without it are the same payees. */
const CATEGORY_RULES: { category: string; counterparty?: RegExp; description?: RegExp; memo?: RegExp }[] = [
  { category: PAYROLL, counterparty: /^intuit\b/i, description: /;\s*(payroll|tax)\s*;/i },
  { category: PAYROLL, memo: /\b(final pay|pay period)\b/i },
  { category: PAYROLL, counterparty: /\bqoqazeh\b/i },
  { category: PAYROLL, counterparty: /^marwane ait si ahmad\b/i },
  { category: CONTRACTORS, memo: /\bcontractor\s*:\s*consulting\b/i },
  { category: CONTRACTORS, counterparty: /^ontario inc\b/i },
  { category: CONTRACTORS, counterparty: /^apricot\b/i },
];

function ruleCategory(t: Describable): string | null {
  const hit = CATEGORY_RULES.find((r) =>
    (!r.counterparty || r.counterparty.test(t.counterparty ?? ""))
    && (!r.description || r.description.test(t.description ?? ""))
    && (!r.memo || r.memo.test(t.memo ?? "")));
  return hit?.category ?? null;
}

/** The expense line a payment belongs on: Mercury's category if the team set
 * one, else what the rules make of it, else Uncategorized. */
export function categoryOf(t: Describable & Pick<BankTxn, "category">): string {
  return t.category?.trim() || ruleCategory(t) || UNCATEGORIZED;
}

export type Flow = "transfer" | "stripe_payout" | "vendor_refund" | "other_receipt" | "expense";

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
 * funding wire can never make the company look as if it has stopped burning.
 *
 * The one exception is money a vendor sends BACK: it says "refund" and comes
 * from a payee the rules above know (Apricot's $7,840 "Silent Witness Refund",
 * 2026-10-02). That is spend undone, so it comes off that vendor's expense
 * line. Both conditions are needed - the word alone, from a stranger, stays a
 * receipt. */
export function flowOf(t: Pick<BankTxn, "amount" | "kind"> & Describable): Flow {
  if (TRANSFER_KINDS.has(t.kind ?? "")) return "transfer";
  // Either sign: a payout Stripe claws back nets against the ones it paid.
  if (/\bstripe\b/i.test(`${t.counterparty ?? ""} ${t.description ?? ""}`)) return "stripe_payout";
  if (t.amount <= 0) return "expense";
  return /\brefund/i.test(`${t.memo ?? ""} ${t.description ?? ""}`) && ruleCategory(t)
    ? "vendor_refund" : "other_receipt";
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
  /** The month's cost, as a positive number: payments out of Mercury, less
   * vendor refunds, plus Meta ads paid outside Mercury (before Oct 2026). */
  expenses: number;
  byCategory: Record<string, number>;
  /** revenue - expenses. */
  netIncome: number | null;
  openingCash: number;
  stripePayouts: number;
  /** Money in that is not a Stripe payout, vendor refunds included. */
  otherReceipts: number;
  /** Every payment that left Mercury, gross, as a positive number. The cash
   * statement's figure; `expenses` is the income statement's. */
  paidOut: number;
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
  /** Spend in `months` that neither Mercury nor a rule here could categorize. */
  uncategorized: number;
  /** Spend in `months`, the denominator for `uncategorized`. */
  totalExpenses: number;
  /** Vendor refunds in `months`, already taken off the expense lines. */
  vendorRefunds: number;
}

export interface RevenueByMonth {
  /** False when Stripe has never synced: revenue is unknown, not zero. */
  ready: boolean;
  byMonth: Map<number, number>;
  refundedByMonth: Map<number, number>;
}

export interface AdSpendByMonth {
  /** False when Meta spend has never synced: unknown, not zero. */
  ready: boolean;
  byMonth: Map<number, number>;
}

const cents = (n: number) => Math.round(n * 100) / 100;

export function monthLabel(index: number): string {
  return new Date(Date.UTC(Math.floor(index / 12), index % 12, 1))
    .toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** The statements, from data already in hand. Pure: everything it needs is an
 * argument, so it is the part the tests exercise. */
export function buildFinance({
  accounts, txns, revenue, adSpend, adsOffBankBefore = CARD_PAID_FROM_MERCURY_SINCE,
  now = new Date(), months = 6,
}: {
  accounts: { name: string; balance: number }[];
  txns: BankTxn[];
  revenue: RevenueByMonth;
  /** Meta's own spend figures. Counted only for months before `adsOffBankBefore`. */
  adSpend?: AdSpendByMonth;
  /** Month index from which the ads are inside Mercury's card payments. */
  adsOffBankBefore?: number;
  now?: Date;
  /** How many calendar months to show, the current one included. */
  months?: number;
}): FinanceSummary {
  const cash = cents(accounts.reduce((s, a) => s + a.balance, 0));
  const nowIdx = monthIndexOf(now.toISOString())!;

  type Agg = {
    payouts: number; other: number; transfers: number;
    /** Payments out, gross. */
    paidOut: number;
    /** Vendor refunds in. */
    refunds: number;
    byCategory: Record<string, number>;
  };
  const blank = (): Agg => ({ payouts: 0, other: 0, transfers: 0, paidOut: 0, refunds: 0, byCategory: {} });
  const agg = new Map<number, Agg>();
  /** Meta ads that ran in month `i` and were not paid for through Mercury. */
  const adsOffBank = (i: number) =>
    adSpend?.ready && i < adsOffBankBefore ? adSpend.byMonth.get(i) ?? 0 : 0;
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
      // A payment adds to its category's line; a vendor's refund comes off it.
      const category = categoryOf(t);
      if (flow === "vendor_refund") a.refunds += t.amount;
      else a.paidOut -= t.amount;
      a.byCategory[category] = (a.byCategory[category] ?? 0) - t.amount;
    }
  }

  // Open on the first month in the window where something happened: a column
  // of dashes ahead of it says nothing. "Something" is a dollar or more moving
  // through the bank, any Stripe revenue, or ads paid for elsewhere - the
  // pennies a provider deposits and takes back to verify the account (Intuit,
  // June 2026) do not count.
  const quiet = (i: number) => {
    const a = agg.get(i);
    const moved = a
      ? Math.abs(a.payouts) + Math.abs(a.other) + Math.abs(a.transfers) + a.paidOut + a.refunds : 0;
    return moved < 1 && adsOffBank(i) < 1 && !(revenue.ready && (revenue.byMonth.get(i) ?? 0) > 0);
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
    // Cash moves on what went through the bank; the ads paid elsewhere are a
    // cost of the month but never left this account.
    const opening = closing - (a.payouts + a.other + a.refunds + a.transfers - a.paidOut);
    const ads = adsOffBank(i);
    const byCategory = { ...a.byCategory };
    if (ads > 0) byCategory[META_ADS] = ads;
    const expenses = a.paidOut - a.refunds + ads;
    const rev = revenue.ready ? revenue.byMonth.get(i) ?? 0 : null;
    out.unshift({
      index: i,
      label: monthLabel(i),
      partial: i === nowIdx,
      revenue: rev === null ? null : cents(rev),
      refunded: revenue.ready ? cents(revenue.refundedByMonth.get(i) ?? 0) : null,
      expenses: cents(expenses),
      byCategory: Object.fromEntries(
        Object.entries(byCategory).map(([k, v]) => [k, cents(v)])),
      netIncome: rev === null ? null : cents(rev - expenses),
      openingCash: cents(opening),
      stripePayouts: cents(a.payouts),
      otherReceipts: cents(a.other + a.refunds),
      paidOut: cents(a.paidOut),
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
    vendorRefunds: cents(out.reduce((s, m) => s + (agg.get(m.index)?.refunds ?? 0), 0)),
  };
}

export type FinanceResult =
  | { status: "ok"; summary: FinanceSummary }
  /** No Mercury token configured: there is nothing to show. */
  | { status: "off" }
  /** Mercury did not answer. The rest of the page must still render. */
  | { status: "error"; message: string };

/** Meta's reported ad spend by month, from the daily rows /api/cron/meta-spend
 * keeps. Paged: a row a day passes PostgREST's 1,000-row cap in time. */
async function loadAdSpend(): Promise<AdSpendByMonth> {
  const days = await selectAll<{ day: string; spend_cents: number }>(
    "meta_ad_spend_daily", "day, spend_cents", "day");
  const byMonth = new Map<number, number>();
  for (const d of days) {
    const i = monthIndexOf(d.day);
    if (i !== null) byMonth.set(i, (byMonth.get(i) ?? 0) + d.spend_cents / 100);
  }
  return { ready: days.length > 0, byMonth };
}

/** Read Mercury live and Stripe revenue from the cache, and build the
 * statements. Never throws: a bank outage is reported, not propagated. */
export async function financeSummary(now = new Date()): Promise<FinanceResult> {
  if (!mercuryConfigured()) return { status: "off" };
  try {
    // Stripe or Meta failing is not a reason to hide the bank balance: that
    // figure then reads as unknown and the cash side still shows.
    const [accounts, facts, adSpend] = await Promise.all([
      listAccounts(),
      loadRevenueFacts().catch(() => null),
      loadAdSpend().catch(() => undefined),
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
        memo: t.externalMemo ?? null,
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
        adSpend,
        now,
      }),
    };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
