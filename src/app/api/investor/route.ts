import { NextRequest } from "next/server";
import { env } from "@/lib/env";
import { investorFeed } from "@/lib/investor-feed";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Read-only feed for the investor data room (sw-investor-room on Vercel).
 * Bearer INVESTOR_FEED_TOKEN - a separate secret from CRON_SECRET so the data
 * room can never trigger a sync, and rotating one does not break the other.
 * Fails closed when the token is unset. */
export async function GET(req: NextRequest) {
  const token = env.investorFeedToken();
  if (!token || req.headers.get("authorization") !== `Bearer ${token}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const feed = await investorFeed();
  return Response.json(feed, { headers: { "cache-control": "private, max-age=300" } });
}
