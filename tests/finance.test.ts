import { describe, expect, it } from "vitest";
import { UNCATEGORIZED, buildFinance, flowOf, type BankTxn } from "@/lib/finance";
import { monthIndexOf } from "@/lib/revenue";

const NOW = new Date("2026-11-25T15:00:00Z");
const idx = (month: string) => monthIndexOf(`${month}-15T00:00:00Z`)!;

const txn = (
  day: string, amount: number,
  rest: Partial<Pick<BankTxn, "kind" | "counterparty" | "category" | "description">> = {},
): BankTxn => ({
  amount, at: `${day}T12:00:00Z`, kind: "other", counterparty: null,
  description: null, category: null, ...rest,
});

const revenue = (byMonth: Record<string, number>, refunded: Record<string, number> = {}) => ({
  ready: true,
  byMonth: new Map(Object.entries(byMonth).map(([m, v]) => [idx(m), v])),
  refundedByMonth: new Map(Object.entries(refunded).map(([m, v]) => [idx(m), v])),
});
const noStripe = { ready: false, byMonth: new Map<number, number>(), refundedByMonth: new Map<number, number>() };

const build = (txns: BankTxn[], rev = revenue({}), cash = 100_000) =>
  buildFinance({ accounts: [{ name: "Checking", balance: cash }], txns, revenue: rev, now: NOW });
const month = (s: ReturnType<typeof build>, m: string) => s.months.find((x) => x.index === idx(m))!;

describe("flowOf", () => {
  it("keeps money moved between the company's own accounts out of income and spend", () => {
    expect(flowOf({ amount: 375_745, kind: "externalTransfer", counterparty: "Chase - Checking", description: null })).toBe("transfer");
    expect(flowOf({ amount: -5_000, kind: "internalTransfer", counterparty: "Mercury Savings", description: null })).toBe("transfer");
    expect(flowOf({ amount: -50_000, kind: "treasuryTransfer", counterparty: null, description: null })).toBe("transfer");
  });

  it("recognises a Stripe payout by its counterparty or bank description", () => {
    expect(flowOf({ amount: 3_866, kind: "other", counterparty: "Stripe", description: null })).toBe("stripe_payout");
    expect(flowOf({ amount: 3_866, kind: "other", counterparty: null, description: "STRIPE; TRANSFER; SILENT WITNESS INC" })).toBe("stripe_payout");
    // A payout Stripe pulls back nets against the others rather than reading as spend.
    expect(flowOf({ amount: -200, kind: "other", counterparty: "Stripe", description: null })).toBe("stripe_payout");
  });

  it("treats any other money in as a receipt and any other money out as spend", () => {
    expect(flowOf({ amount: 7_840, kind: "incomingDomesticWire", counterparty: "APRICOT INC.", description: null })).toBe("other_receipt");
    expect(flowOf({ amount: -7_500, kind: "outgoingPayment", counterparty: "Ontario Inc", description: null })).toBe("expense");
    // A card paid from the bank is spend, whatever the bank calls it.
    expect(flowOf({ amount: -16_000, kind: "other", counterparty: "Chase", description: "CHASE CREDIT CRD; EPAY" })).toBe("expense");
  });
});

describe("buildFinance", () => {
  it("takes revenue from Stripe gross and never from the bank", () => {
    const s = build(
      [txn("2026-10-26", 3_159, { counterparty: "Stripe" }),
       txn("2026-10-10", -40_000, { category: "Payroll" })],
      revenue({ "2026-10": 27_000 }, { "2026-10": 3_800 }),
    );
    const oct = month(s, "2026-10");
    // Gross: the refunded $3,800 is shown, not taken off.
    expect(oct.revenue).toBe(27_000);
    expect(oct.refunded).toBe(3_800);
    expect(oct.netIncome).toBe(-13_000);
    // The payout is cash, in the cash statement only.
    expect(oct.stripePayouts).toBe(3_159);
  });

  it("does not let a transfer in or a wire in reduce burn", () => {
    // Funded with $375k in a month it spent $40k: that is a $40k burn month.
    const s = build(
      [txn("2026-10-02", 375_745, { kind: "externalTransfer", counterparty: "Chase - Checking" }),
       txn("2026-10-02", 7_840, { kind: "incomingDomesticWire", counterparty: "APRICOT INC." }),
       txn("2026-10-10", -40_000, { category: "Payroll" })],
      revenue({ "2026-10": 0 }),
    );
    const oct = month(s, "2026-10");
    expect(oct.expenses).toBe(40_000);
    expect(oct.transfers).toBe(375_745);
    expect(oct.otherReceipts).toBe(7_840);
    expect(s.netBurn).toBe(40_000);
    expect(s.transferSources).toEqual(["Chase - Checking"]);
  });

  it("averages burn over the last three complete months, not the running one", () => {
    const s = build(
      [txn("2026-07-10", -90_000), // older than the three-month window
       txn("2026-08-10", -30_000),
       txn("2026-09-10", -40_000),
       txn("2026-10-10", -56_000),
       txn("2026-11-10", -5_000)], // this month, 25 days in
      revenue({ "2026-08": 10_000, "2026-09": 12_000, "2026-10": 20_000, "2026-11": 99_000 }),
    );
    expect(s.burnBasis).toEqual(["Aug 2026", "Sep 2026", "Oct 2026"]);
    expect(s.grossBurn).toBe(42_000);
    expect(s.netBurn).toBe(28_000);
    expect(s.runwayMonths).toBeCloseTo(100_000 / 28_000, 6);
    expect(s.cashOut).toBe("Mar 2027");
    expect(month(s, "2026-11").partial).toBe(true);
  });

  it("uses the months it has when the account is younger than three months", () => {
    const s = build([txn("2026-10-10", -20_000)], revenue({}));
    expect(s.burnBasis).toEqual(["Oct 2026"]);
    expect(s.grossBurn).toBe(20_000);
  });

  it("reports no runway, rather than a negative one, when revenue covers spend", () => {
    const s = build([txn("2026-10-10", -20_000)], revenue({ "2026-10": 25_000 }));
    expect(s.netBurn).toBe(-5_000);
    expect(s.runwayMonths).toBeNull();
    expect(s.cashOut).toBeNull();
  });

  it("leaves net burn and runway unknown when Stripe has never synced", () => {
    // Unknown revenue is not zero revenue: the cash side still shows.
    const s = build([txn("2026-10-10", -20_000)], noStripe);
    expect(month(s, "2026-10").revenue).toBeNull();
    expect(month(s, "2026-10").netIncome).toBeNull();
    expect(s.grossBurn).toBe(20_000);
    expect(s.netBurn).toBeNull();
    expect(s.runwayMonths).toBeNull();
  });

  it("walks month-end balances back from today's bank balance", () => {
    const s = build(
      [txn("2026-09-05", 50_000, { kind: "externalTransfer", counterparty: "Chase" }),
       txn("2026-09-20", -10_000),
       txn("2026-10-20", -15_000),
       txn("2026-11-03", 4_000, { counterparty: "Stripe" }),
       txn("2026-11-20", -9_000)],
      revenue({}), 20_000,
    );
    expect(month(s, "2026-11").closingCash).toBe(20_000);
    expect(month(s, "2026-11").openingCash).toBe(25_000);
    expect(month(s, "2026-10").closingCash).toBe(25_000);
    expect(month(s, "2026-10").openingCash).toBe(40_000);
    expect(month(s, "2026-09").openingCash).toBe(0);
    // Every month's close is the next month's open.
    for (let i = 1; i < s.months.length; i += 1) {
      expect(s.months[i].openingCash).toBe(s.months[i - 1].closingCash);
    }
  });

  it("groups spend by the category set in Mercury, with the rest last", () => {
    const s = build([
      txn("2026-10-01", -1_000, { category: "Legal" }),
      txn("2026-10-02", -9_000),
      txn("2026-10-03", -5_000, { category: "Payroll" }),
      txn("2026-10-04", -2_000, { category: "Payroll" }),
    ]);
    // Largest first, but Uncategorized always at the bottom however big it is.
    expect(s.categories).toEqual(["Payroll", "Legal", UNCATEGORIZED]);
    expect(month(s, "2026-10").byCategory).toEqual({ Payroll: 7_000, Legal: 1_000, [UNCATEGORIZED]: 9_000 });
    expect(s.uncategorized).toBe(9_000);
    expect(s.totalExpenses).toBe(17_000);
  });

  it("shows six months at most and never one before the first transaction", () => {
    const old = build([txn("2025-12-10", -1_000), txn("2026-06-10", -1_000), txn("2026-10-10", -1_000)]);
    // A quiet month in the middle (Jul to Sep) stays; only leading ones go.
    expect(old.months.map((m) => m.label)).toEqual(
      ["Jun 2026", "Jul 2026", "Aug 2026", "Sep 2026", "Oct 2026", "Nov 2026"]);
    const young = build([txn("2026-10-10", -1_000)]);
    expect(young.months.map((m) => m.label)).toEqual(["Oct 2026", "Nov 2026"]);
  });

  it("does not open the table on a quiet month", () => {
    // Money arrived in April, then nothing but account-verification pennies
    // until the first real payment in October.
    const s = build([
      txn("2026-04-29", 500, { kind: "externalTransfer", counterparty: "Chase" }),
      txn("2026-06-26", 0.19, { counterparty: "ACCTVERIFY INTUIT INC." }),
      txn("2026-06-29", -0.19, { counterparty: "Intuit" }),
      txn("2026-10-10", -1_000),
    ]);
    expect(s.months.map((m) => m.label)).toEqual(["Oct 2026", "Nov 2026"]);
    // Everything before the window is still inside the balance it opens on.
    expect(s.months[0].openingCash).toBe(101_000);
  });

  it("keeps a month with Stripe revenue even if the bank was quiet", () => {
    const s = build([txn("2026-10-10", -1_000)], revenue({ "2026-08": 4_000 }));
    expect(s.months.map((m) => m.label)).toEqual(["Aug 2026", "Sep 2026", "Oct 2026", "Nov 2026"]);
  });

  it("adds every account's balance into cash", () => {
    const s = buildFinance({
      accounts: [{ name: "Checking", balance: 333_499.02 }, { name: "Savings", balance: 1_000.5 }],
      txns: [], revenue: revenue({}), now: NOW,
    });
    expect(s.cash).toBe(334_499.52);
    expect(s.months).toHaveLength(1);
  });
});
