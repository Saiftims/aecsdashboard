import { loadSettings } from "@/lib/settings";
import { supabaseService } from "@/lib/supabase/server";

/** Inputs for the paid-acquisition payback model on the Activity page.
 *
 * MQLs are sales deals created this calendar month - intake deals, activation
 * deals and our own contact-form tests are not demand. New subscribers are
 * Stripe subscriptions started this month that bill something; MRR is the
 * BILLED amount after discounts, never list price. */
export interface UnitEconomicsSnapshot {
  monthLabel: string;
  daysElapsed: number;
  daysInMonth: number;
  adSpend: number;
  adLeadShare: number;
  mqls: number;
  newSubscribers: number;
  newSubscriberMrr: number;
  activeSubscribers: number;
  liveMrr: number;
}

const INTERNAL_DEAL = /silent\s?witness/i;

export async function unitEconomicsSnapshot(): Promise<UnitEconomicsSnapshot> {
  const sb = supabaseService();
  const settings = await loadSettings();
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();

  const [{ data: deals }, { data: subs }] = await Promise.all([
    sb.from("deals").select("name, is_activation, hs_created_at")
      .gte("hs_created_at", monthStart.toISOString()),
    sb.from("stripe_subscriptions")
      .select("billed_cents, monthly_cents, status, is_internal, started_at"),
  ]);

  const mqls = (deals ?? []).filter((d) =>
    !d.is_activation
    && !/intake/i.test(d.name ?? "")
    && !INTERNAL_DEAL.test(d.name ?? "")).length;

  let activeSubscribers = 0;
  let liveMrr = 0;
  let newSubscribers = 0;
  let newSubscriberMrr = 0;
  for (const s of subs ?? []) {
    if (s.is_internal || s.status !== "active") continue;
    const billed = (s.billed_cents ?? s.monthly_cents ?? 0) / 100;
    if (billed <= 0) continue;
    activeSubscribers += 1;
    liveMrr += billed;
    if (s.started_at && new Date(s.started_at) >= monthStart) {
      newSubscribers += 1;
      newSubscriberMrr += billed;
    }
  }

  return {
    monthLabel: now.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
    daysElapsed: now.getUTCDate(),
    daysInMonth,
    adSpend: settings.monthlyAdSpend,
    adLeadShare: settings.adLeadSharePct / 100,
    mqls,
    newSubscribers,
    newSubscriberMrr,
    activeSubscribers,
    liveMrr,
  };
}
