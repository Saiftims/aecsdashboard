import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { OAUTH_COOKIE, authorizeUrl, pkcePair } from "@/lib/sync/readai-backfill";
import { tokensMatch } from "@/lib/sync/readai";

/** Start connecting a Read.ai account for the history import.
 *
 * Share `/api/readai/connect?key=<READAI_WEBHOOK_TOKEN>` with a rep; they
 * sign in to Read.ai, allow access, and land on the callback which stores
 * their refresh token. The key stops strangers from attaching accounts;
 * the state cookie binds the callback to this browser. */
export async function GET(req: NextRequest) {
  const key = env.readaiWebhookToken();
  if (!key || !tokensMatch(req.nextUrl.searchParams.get("key"), key)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!env.readaiClientId() || !env.readaiClientSecret()) {
    return NextResponse.json({ error: "READAI_CLIENT_ID / READAI_CLIENT_SECRET are not set" }, { status: 503 });
  }
  const state = randomBytes(16).toString("base64url");
  const { verifier, challenge } = pkcePair();
  const res = NextResponse.redirect(authorizeUrl(state, challenge));
  res.cookies.set(OAUTH_COOKIE, JSON.stringify({ state, verifier }), {
    httpOnly: true, secure: env.isVercel(), sameSite: "lax", path: "/api/readai", maxAge: 600,
  });
  return res;
}
