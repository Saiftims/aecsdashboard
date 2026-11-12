import { NextRequest, NextResponse, after } from "next/server";
import { env } from "@/lib/env";
import { processMeeting, storeMeeting, tokensMatch, verifyReadAiSignature, type ReadAiPayload } from "@/lib/sync/readai";

export const maxDuration = 300;

/** Read.ai webhook (Integrations -> Webhooks -> trigger "meeting_end").
 *
 * Accepted when either check passes:
 *  - `X-Read-Signature` verifies against one of the keys in
 *    READAI_WEBHOOK_SECRET (comma-separated, one per Read.ai webhook), or
 *  - the URL carries `?token=` equal to READAI_WEBHOOK_TOKEN.
 * With neither configured the endpoint refuses everything on Vercel.
 *
 * The payload is stored first and acknowledged with 202 straight away;
 * extraction and the HubSpot writes run after the response (Read.ai does not
 * wait for them, and would otherwise re-deliver on timeout). Anything that
 * fails here is picked up by /api/cron/readai. */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const secrets = env.readaiWebhookSecrets();
  const token = env.readaiWebhookToken();
  const sig = req.headers.get("x-read-signature");
  const okSig = secrets.some((s) => verifyReadAiSignature(raw, sig, s));
  const okTok = token ? tokensMatch(req.nextUrl.searchParams.get("token"), token) : false;
  if (!okSig && !okTok) {
    if (!secrets.length && !token && !env.isVercel()) { /* local dev without config */ } else {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  let payload: ReadAiPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!payload?.session_id) return NextResponse.json({ error: "session_id missing" }, { status: 400 });
  // meeting_start carries no report; only the end-of-meeting payload is useful.
  if (payload.trigger && payload.trigger !== "meeting_end") return NextResponse.json({ ignored: payload.trigger }, { status: 200 });

  const { fresh } = await storeMeeting(payload);
  if (!fresh) return NextResponse.json({ duplicate: true }, { status: 200 });

  after(async () => {
    try {
      const r = await processMeeting(payload.session_id);
      console.log("readai processed", payload.session_id, JSON.stringify(r).slice(0, 500));
    } catch (e) {
      console.error("readai process failed", payload.session_id, e instanceof Error ? e.message : e);
    }
  });
  return NextResponse.json({ accepted: true, session_id: payload.session_id }, { status: 202 });
}
