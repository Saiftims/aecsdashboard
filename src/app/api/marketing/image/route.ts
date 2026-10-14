import { NextRequest, NextResponse } from "next/server";
import { readCreatives } from "@/lib/meta/client";
import { creativeFields } from "@/lib/sync/meta";
import { supabaseService } from "@/lib/supabase/server";

export const maxDuration = 30;

/** Serves an ad's creative image. Meta's CDN links carry an expiry, so the
 * cached URL is tried first and, if it has lapsed, the creative is re-read
 * from Meta and the fresh link stored. Protected by the app middleware like
 * every other non-cron API route. `?thumb=1` returns the small thumbnail. */
export async function GET(req: NextRequest) {
  const adId = req.nextUrl.searchParams.get("ad");
  const thumb = req.nextUrl.searchParams.get("thumb") === "1";
  if (!adId) return NextResponse.json({ error: "ad required" }, { status: 400 });
  const sb = supabaseService();
  const { data: ad } = await sb.from("meta_ads").select("creative_id, image_url, thumbnail_url").eq("ad_id", adId).maybeSingle();
  if (!ad) return NextResponse.json({ error: "unknown ad" }, { status: 404 });

  const pick = (row: { image_url: string | null; thumbnail_url: string | null }) =>
    (thumb ? row.thumbnail_url ?? row.image_url : row.image_url ?? row.thumbnail_url) ?? null;

  const tryFetch = async (url: string | null) => {
    if (!url) return null;
    const r = await fetch(url, { cache: "no-store" }).catch(() => null);
    return r && r.ok ? r : null;
  };

  let upstream = await tryFetch(pick(ad));
  if (!upstream && ad.creative_id) {
    const c = (await readCreatives([ad.creative_id]).catch(() => new Map())).get(ad.creative_id);
    if (c) {
      const f = creativeFields(c);
      await sb.from("meta_ads").update({ image_url: f.image_url, thumbnail_url: f.thumbnail_url }).eq("ad_id", adId);
      upstream = await tryFetch(pick({ image_url: f.image_url, thumbnail_url: f.thumbnail_url }));
    }
  }
  if (!upstream) return new NextResponse(null, { status: 404 });
  const body = await upstream.arrayBuffer();
  return new NextResponse(body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
      "Cache-Control": "private, max-age=21600",
    },
  });
}
