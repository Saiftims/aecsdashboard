import { describe, expect, it } from "vitest";
import {
  CARD_OTHER, CONTRACTORS, META_ADS, PAYROLL, UNCATEGORIZED, buildFinance, categoryOf, flowOf, type BankTxn,
} from "@/lib/finance";
import { monthIndexOf } from "@/lib/revenue";

const NOW = new Date("2026-11-25T15:00:00Z");
const idx = (month: string) => monthIndexOf(`${month}-15T00:00:00Z`)!;

const txn = (
  day: string, amount: number,
  rest: Partial<Pick<BankTxn, "kind" | "counterparty" | "category" | "description" | "memo">> = {},
): BankTxn => ({
  amount, at: `${day}T12:00:00Z`, kind: "other", counterparty: null,
  description: null, memo: null, category: null, ...rest,
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

  it("reads money a known vendor sends back as a refund, and nothing else", () => {
    const wire = { amount: 7_840, kind: "incomingDomesticWire", description: null };
    expect(flowOf({ ...wire, counterparty: "APRICOT INC.", memo: "Silent Witness Refund" })).toBe("vendor_refund");
    // The word alone is not enough: this payee has never been paid.
    expect(flowOf({ ...wire, counterparty: "Some Fund LP", memo: "refund" })).toBe("other_receipt");
    // Nor is the payee alone.
    expect(flowOf({ ...wire, counterparty: "APRICOT INC.", memo: "Investment" })).toBe("other_receipt");
  });
});

describe("categoryOf", () => {
  const pay = (counterparty: string, rest: { description?: string; memo?: string; category?: string } = {}) =>
    categoryOf({ counterparty, description: rest.description ?? null, memo: rest.memo ?? null, category: rest.category ?? null });

  it("files payroll runs, payroll tax and people's pay under Payroll", () => {
    expect(pay("Intuit", { description: "INTUIT 99321681; PAYROLL; SILENT WITNESS INC" })).toBe(PAYROLL);
    expect(pay("Intuit", { description: "INTUIT 02651478; TAX; SILENT WITNESS INC" })).toBe(PAYROLL);
    expect(pay("Victoria Vizcardo", { memo: "Final Pay Pay Period: 7/12/26-7/25/26" })).toBe(PAYROLL);
    expect(pay("AHMAD ABDULKAREEM MOHAMMAD QOQAZEH", { memo: "From Silent Witness Inc" })).toBe(PAYROLL);
    expect(pay("MARWANE AIT SI AHMAD", { memo: "From Silent Witness Inc" })).toBe(PAYROLL);
  });

  it("files contractor invoices under Contractors & Consulting", () => {
    expect(pay("Ontario Inc", { memo: "From Silent Witness Inc via mercury.com; Contractor:Consulting" })).toBe(CONTRACTORS);
    // The first payment went out without the memo; it is the same payee.
    expect(pay("Ontario Inc", { memo: "From Silent Witness Inc via mercury.com" })).toBe(CONTRACTORS);
    expect(pay("Apricot Technologies", { description: "APRICOT INC.; SALE; RAMI HASHISH" })).toBe(CONTRACTORS);
    expect(pay("Someone New LLC", { memo: "Contractor:Consulting" })).toBe(CONTRACTORS);
  });

  it("lets a category set in Mercury win over a rule", () => {
    expect(pay("Ontario Inc", { memo: "Contractor:Consulting", category: "Legal" })).toBe("Legal");
  });

  it("leaves a payee it knows nothing about uncategorized rather than guess", () => {
    expect(pay("Croboost.ai", { memo: "From Silent Witness Inc via mercury.com" })).toBe(UNCATEGORIZED);
    // Intuit's account-verification pennies are not payroll.
    expect(pay("Intuit", { description: "INTUIT INC; ACCTVERIFY; RAMI HASHISH" })).toBe(UNCATEGORIZED);
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

  const CARD = { counterparty: "Chase", description: "CHASE CREDIT CRD; EPAY; RAMI HASHISH", category: "Credit & Loan Payments" };

  it("gives Meta ads their own line: on top before Mercury paid the card, carved out of it after", () => {
    const txns = [
      txn("2026-08-10", -30_000, { category: "Payroll" }),
      txn("2026-09-10", -40_000, { category: "Payroll" }),
      txn("2026-10-10", -16_000, { category: "Payroll" }),
      // The card the ads run on, paid from Mercury from here on.
      txn("2026-10-29", -24_000, CARD),
    ];
    const s = buildFinance({
      accounts: [{ name: "Checking", balance: 100_000 }], txns, revenue: revenue({ "2026-10": 10_000 }), now: NOW,
      adSpend: { ready: true, byMonth: new Map([
        [idx("2026-08"), 7_718], [idx("2026-09"), 4_810], [idx("2026-10"), 9_250],
      ]) },
    });
    // Before October the card was paid elsewhere: the ads are extra spend.
    expect(month(s, "2026-08").byCategory[META_ADS]).toBe(7_718);
    expect(month(s, "2026-08").expenses).toBe(37_718);
    expect(month(s, "2026-09").expenses).toBe(44_810);
    // October: the ads are inside the $24,000 card payment. Splitting it must
    // not change the month's total - counting both would be twice.
    const oct = month(s, "2026-10");
    expect(oct.byCategory).toEqual({ Payroll: 16_000, [META_ADS]: 9_250, [CARD_OTHER]: 14_750 });
    expect(oct.expenses).toBe(40_000);
    expect(oct.paidOut).toBe(40_000);
    expect(s.grossBurn).toBe(Math.round(((37_718 + 44_810 + 40_000) / 3) * 100) / 100);
  });

  it("carries ads the card has not been paid for yet to the next card payment", () => {
    // October's ads ran with no card payment that month; November's payment
    // covers both months' ads and $4,000 of other purchases.
    const s = buildFinance({
      accounts: [{ name: "Checking", balance: 100_000 }],
      txns: [txn("2026-10-10", -1_000, { category: "Payroll" }), txn("2026-11-16", -12_000, CARD)],
      revenue: revenue({}), now: NOW,
      adSpend: { ready: true, byMonth: new Map([[idx("2026-10"), 5_000], [idx("2026-11"), 3_000]]) },
    });
    expect(month(s, "2026-10").byCategory).toEqual({ Payroll: 1_000, [META_ADS]: 5_000 });
    expect(month(s, "2026-10").expenses).toBe(6_000);
    expect(month(s, "2026-11").byCategory).toEqual({ [META_ADS]: 3_000, [CARD_OTHER]: 4_000 });
    expect(month(s, "2026-11").expenses).toBe(7_000);
    // Across the two months, spend comes to exactly what left the bank.
    expect(s.months.reduce((sum, m) => sum + m.expenses, 0)).toBe(13_000);
    expect(s.months.reduce((sum, m) => sum + m.paidOut, 0)).toBe(13_000);
  });

  it("never takes more out of a card payment than was paid", () => {
    const s = buildFinance({
      accounts: [{ name: "Checking", balance: 100_000 }],
      txns: [txn("2026-10-29", -2_000, CARD)], revenue: revenue({}), now: NOW,
      adSpend: { ready: true, byMonth: new Map([[idx("2026-10"), 9_000]]) },
    });
    const oct = month(s, "2026-10");
    expect(oct.byCategory[CARD_OTHER]).toBe(0);
    expect(oct.byCategory[META_ADS]).toBe(9_000);
    expect(oct.expenses).toBe(9_000);
  });

  it("leaves the card payment whole, under Mercury's category, when Meta has never synced", () => {
    const s = build([txn("2026-10-29", -24_000, CARD)]);
    expect(month(s, "2026-10").byCategory).toEqual({ "Credit & Loan Payments": 24_000 });
  });

  it("keeps Meta ads paid elsewhere out of the cash statement", () => {
    const txns = [txn("2026-09-10", -40_000), txn("2026-10-10", -16_000)];
    const args = { accounts: [{ name: "Checking", balance: 100_000 }], txns, revenue: revenue({}), now: NOW };
    const without = buildFinance(args);
    const s = buildFinance({ ...args, adSpend: { ready: true, byMonth: new Map([[idx("2026-09"), 4_810]]) } });
    const sep = month(s, "2026-09");
    expect(sep.expenses).toBe(44_810);
    // The money did not leave Mercury: payments out and balances are unmoved.
    expect(sep.paidOut).toBe(40_000);
    expect(sep.openingCash).toBe(month(without, "2026-09").openingCash);
    expect(sep.closingCash).toBe(month(without, "2026-09").closingCash);
  });

  it("adds no Meta spend when it has never synced", () => {
    const txns = [txn("2026-09-10", -40_000)];
    const s = buildFinance({
      accounts: [{ name: "Checking", balance: 1 }], txns, revenue: revenue({}), now: NOW,
      adSpend: { ready: false, byMonth: new Map([[idx("2026-09"), 4_810]]) },
    });
    expect(month(s, "2026-09").expenses).toBe(40_000);
    expect(s.categories).not.toContain(META_ADS);
  });

  it("takes a vendor's refund off that vendor's expense line, not into revenue", () => {
    const s = build(
      [txn("2026-10-01", -4_200, { counterparty: "Apricot Inc", memo: "Contractor:Consulting" }),
       txn("2026-10-13", -7_500, { counterparty: "Ontario Inc", memo: "Contractor:Consulting" }),
       txn("2026-10-02", 7_840, { kind: "incomingDomesticWire", counterparty: "APRICOT INC.", memo: "Silent Witness Refund" })],
      revenue({ "2026-10": 1_000 }),
    );
    const oct = month(s, "2026-10");
    expect(oct.byCategory).toEqual({ [CONTRACTORS]: 3_860 });
    expect(oct.expenses).toBe(3_860);
    expect(oct.revenue).toBe(1_000);
    expect(s.vendorRefunds).toBe(7_840);
    // The cash statement stays literal: what went out, and what came in.
    expect(oct.paidOut).toBe(11_700);
    expect(oct.otherReceipts).toBe(7_840);
    expect(oct.openingCash).toBe(100_000 + 11_700 - 7_840);
  });

  it("categorizes a payment Mercury left blank from its payee and memo", () => {
    const s = build([
      txn("2026-10-09", -645.54, { counterparty: "Intuit", description: "INTUIT 10467781; TAX; SILENT WITNESS INC" }),
      txn("2026-10-09", -1_500, { counterparty: "Intuit", description: "INTUIT 06254107; PAYROLL; SILENT WITNESS INC", category: "Payroll" }),
      txn("2026-10-13", -7_500, { counterparty: "Ontario Inc", memo: "Contractor:Consulting" }),
      txn("2026-10-20", -1_000, { counterparty: "Croboost.ai" }),
    ]);
    expect(month(s, "2026-10").byCategory).toEqual({
      [PAYROLL]: 2_145.54, [CONTRACTORS]: 7_500, [UNCATEGORIZED]: 1_000,
    });
    expect(s.uncategorized).toBe(1_000);
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

  it("reads burn from one month's column, as it stands, when a basis month is set", () => {
    const txns = [
      txn("2026-08-10", -30_000), txn("2026-09-10", -40_000),
      txn("2026-10-10", -56_000), txn("2026-11-10", -35_000),
    ];
    const rev = revenue({ "2026-08": 10_000, "2026-09": 12_000, "2026-10": 20_000, "2026-11": 25_000 });
    // November is still running on NOW (the 25th): taken to date, not prorated.
    const s = buildFinance({
      accounts: [{ name: "Checking", balance: 100_000 }], txns, revenue: rev, now: NOW, burnBasisMonth: "2026-11",
    });
    expect(s.burnMode).toBe("snapshot");
    expect(s.burnBasis).toEqual(["Nov 2026"]);
    expect(s.burnBasisPartial).toBe(true);
    expect(s.grossBurn).toBe(35_000);
    expect(s.netBurn).toBe(10_000);
    expect(s.runwayMonths).toBeCloseTo(10, 6);
    // The average it replaced is kept for context.
    expect(s.averageGrossBurn).toBe(42_000);
    expect(s.averageNetBurn).toBe(28_000);

    // A complete month reads the same way and is not flagged partial.
    const oct = buildFinance({
      accounts: [{ name: "Checking", balance: 100_000 }], txns, revenue: rev, now: NOW, burnBasisMonth: "2026-10",
    });
    expect(oct.burnBasisPartial).toBe(false);
    expect(oct.grossBurn).toBe(56_000);
    expect(oct.netBurn).toBe(36_000);
  });

  it("falls back to the average when the basis month is not on the statement", () => {
    const txns = [txn("2026-09-10", -40_000), txn("2026-10-10", -50_000)];
    for (const bad of ["2025-01", "2027-03", "", "november"]) {
      const s = buildFinance({
        accounts: [{ name: "Checking", balance: 100_000 }], txns, revenue: revenue({}), now: NOW, burnBasisMonth: bad,
      });
      expect(s.burnMode).toBe("average");
      expect(s.burnBasis).toEqual(["Sep 2026", "Oct 2026"]);
      expect(s.grossBurn).toBe(45_000);
      expect(s.averageGrossBurn).toBeNull();
    }
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
