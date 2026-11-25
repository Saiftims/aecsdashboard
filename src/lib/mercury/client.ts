/** Mercury API client - read-only: the bank accounts and what moved through
 * them. Nothing here can send money; only GET endpoints are called.
 *
 * Read LIVE on each page load rather than synced into Supabase: the whole
 * history is a few hundred rows across two accounts (two requests), and a bank
 * balance that is fifteen minutes old is a worse answer than a fresh one.
 */
import { env } from "@/lib/env";

const BASE = "https://api.mercury.com/api/v1";

/** A slow or down Mercury must not hang the Executive page with it. */
const TIMEOUT_MS = 8000;

export interface MercuryAccount {
  id: string;
  name?: string | null;
  /** checking | savings */
  kind?: string | null;
  status?: string | null;
  /** Posted money, in dollars. Matches the sum of `sent` transactions. */
  currentBalance?: number | null;
  /** `currentBalance` less anything still pending. */
  availableBalance?: number | null;
  createdAt?: string | null;
}

export interface MercuryTransaction {
  id: string;
  /** Dollars. Negative is money out. */
  amount?: number | null;
  /** pending | sent | cancelled | failed. Only `sent` has moved the balance. */
  status?: string | null;
  /** externalTransfer, outgoingPayment, incomingDomesticWire, wireFee, other, ... */
  kind?: string | null;
  createdAt?: string | null;
  postedAt?: string | null;
  counterpartyName?: string | null;
  bankDescription?: string | null;
  /** The category the team (or a Mercury rule) put on the transaction. */
  categoryData?: { name?: string | null } | null;
}

export class MercuryError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export function mercuryConfigured(): boolean {
  return Boolean(env.mercuryApiKey());
}

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const key = env.mercuryApiKey();
  if (!key) throw new MercuryError("MERCURY_API_KEY not configured");
  const q = new URLSearchParams(params).toString();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}${q ? `?${q}` : ""}`, {
      // The token is sent whole, `secret-token:` prefix included.
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new MercuryError(`Mercury ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new MercuryError(
      `Mercury ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
  }
  return await res.json() as T;
}

export async function listAccounts(): Promise<MercuryAccount[]> {
  const body = await get<{ accounts?: MercuryAccount[] }>("/accounts");
  return body.accounts ?? [];
}

/** Every transaction on one account, oldest history included.
 *
 * `start` must be given: without it Mercury answers the last 30 days only,
 * which reads as a complete ledger and is not one. And `total` in the response
 * is the size of THIS page, not of the ledger, so the loop ends on a short
 * page rather than on a count. */
export async function listTransactions(accountId: string): Promise<MercuryTransaction[]> {
  const LIMIT = 500;
  const out: MercuryTransaction[] = [];
  // Guard against an unbounded loop if a page never comes back short.
  for (let page = 0; page < 200; page += 1) {
    const body = await get<{ transactions?: MercuryTransaction[] }>(
      `/account/${accountId}/transactions`,
      { limit: String(LIMIT), offset: String(page * LIMIT), start: "2015-01-01" },
    );
    const batch = body.transactions ?? [];
    out.push(...batch);
    if (batch.length < LIMIT) return out;
  }
  return out;
}
