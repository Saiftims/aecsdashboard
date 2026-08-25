/** Stripe API client - read-only listing of the objects revenue is built from.
 *
 * Plain REST rather than the `stripe` package: the key in use is a RESTRICTED
 * read key, so only a handful of list endpoints are reachable and the SDK's
 * surface would be mostly unusable weight.
 *
 * Everything is cursor-paginated the same way (100 at a time, `starting_after`
 * carrying the last id), so one `page` helper covers all of it.
 */
const BASE = "https://api.stripe.com/v1";

export interface StripeCustomer {
  id: string;
  email?: string | null;
  name?: string | null;
  delinquent?: boolean | null;
  created?: number | null;
}

export interface StripeCharge {
  id: string;
  customer?: string | null;
  amount?: number | null;
  amount_refunded?: number | null;
  currency?: string | null;
  status?: string | null;
  paid?: boolean | null;
  refunded?: boolean | null;
  description?: string | null;
  invoice?: string | null;
  created?: number | null;
  billing_details?: { email?: string | null; name?: string | null } | null;
}

export interface StripeInvoiceLine {
  description?: string | null;
  amount?: number | null;
}

export interface StripeInvoice {
  id: string;
  customer?: string | null;
  status?: string | null;
  amount_paid?: number | null;
  amount_due?: number | null;
  created?: number | null;
  subscription?: string | null;
  status_transitions?: { paid_at?: number | null } | null;
  lines?: { data?: StripeInvoiceLine[] } | null;
}

export interface StripeSubscription {
  id: string;
  customer?: string | null;
  status?: string | null;
  created?: number | null;
  canceled_at?: number | null;
  current_period_end?: number | null;
  items?: {
    data?: {
      price?: {
        unit_amount?: number | null;
        recurring?: { interval?: string | null } | null;
      } | null;
    }[];
  } | null;
}

function key(): string {
  const k = (process.env.STRIPE_API_KEY ?? "").trim();
  if (!k) throw new Error("STRIPE_API_KEY not configured");
  return k;
}

async function page<T>(
  path: string, params: Record<string, string> = {},
): Promise<T[]> {
  const auth = Buffer.from(`${key()}:`).toString("base64");
  const out: T[] = [];
  let startingAfter: string | undefined;
  // Guard against an unbounded loop if Stripe ever keeps saying has_more.
  for (let guard = 0; guard < 200; guard += 1) {
    const q = new URLSearchParams({ ...params, limit: "100" });
    if (startingAfter) q.set("starting_after", startingAfter);
    const res = await fetch(`${BASE}/${path}?${q}`, {
      headers: { Authorization: `Basic ${auth}` },
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`Stripe ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = await res.json() as { data?: T[]; has_more?: boolean };
    const batch = body.data ?? [];
    out.push(...batch);
    if (!body.has_more || batch.length === 0) return out;
    startingAfter = (batch[batch.length - 1] as { id: string }).id;
  }
  return out;
}

export const listCustomers = () => page<StripeCustomer>("customers");
export const listCharges = () => page<StripeCharge>("charges");
export const listInvoices = () => page<StripeInvoice>("invoices");
/** `status: all` so cancelled plans are returned - a cancelled subscriber still
 * billed a flat fee while it ran, and their history depends on knowing that. */
export const listSubscriptions = () =>
  page<StripeSubscription>("subscriptions", { status: "all" });
