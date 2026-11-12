import { NextRequest, NextResponse, after } from "next/server";
import { OAUTH_COOKIE, backfillAccount, connectAccount } from "@/lib/sync/readai-backfill";

export const maxDuration = 300;

const page = (title: string, body: string, status = 200) => new NextResponse(
  `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px/1.5 system-ui;max-width:560px;margin:10vh auto;padding:0 24px;color:#111">
<h1 style="font-size:22px">${title}</h1><p>${body}</p></body>`,
  { status, headers: { "content-type": "text/html; charset=utf-8" } },
);

/** Read.ai sends the browser back here with `code` + `state`. Exchange the
 * code, store the account, start importing its history in the background. */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  if (q.get("error")) return page("Read.ai said no", `${q.get("error")}: ${q.get("error_description") ?? ""}`, 400);
  let saved: { state?: string; verifier?: string } = {};
  try { saved = JSON.parse(req.cookies.get(OAUTH_COOKIE)?.value ?? "{}"); } catch { /* fall through */ }
  const code = q.get("code");
  if (!code || !saved.state || !saved.verifier || q.get("state") !== saved.state) {
    return page("Connection expired", "Please start again from the connect link (it is valid for 10 minutes).", 400);
  }
  try {
    const who = await connectAccount(code, saved.verifier);
    after(async () => {
      try {
        const r = await backfillAccount(who.email, { max: 6, deadline: Date.now() + 270_000 });
        console.log("readai backfill (first run)", JSON.stringify(r).slice(0, 800));
      } catch (e) {
        console.error("readai backfill (first run) failed", e instanceof Error ? e.message : e);
      }
    });
    const res = page("Read.ai connected",
      `Connected <b>${who.email}</b>. Past customer calls are now being imported into HubSpot; the rest continue every 10 minutes. You can close this tab.`);
    res.cookies.set(OAUTH_COOKIE, "", { path: "/api/readai", maxAge: 0 });
    return res;
  } catch (e) {
    return page("Could not connect", e instanceof Error ? e.message : String(e), 500);
  }
}
