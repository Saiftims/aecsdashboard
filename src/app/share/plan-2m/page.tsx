import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Plan2M } from "@/components/plan-2m";
import { env } from "@/lib/env";

export const metadata: Metadata = {
  title: "Path to $2M by June · Silent Witness",
  robots: { index: false, follow: false },
};

/** Link-shareable plan for people without a dashboard login. The URL must
 * carry ?k=<PLAN_SHARE_KEY>; anything else 404s so the path reveals nothing. */
export default async function SharedPlanPage({ searchParams }: { searchParams: Promise<{ k?: string | string[] }> }) {
  const key = env.planShareKey();
  const { k } = await searchParams;
  const given = Array.isArray(k) ? k[0] : k;
  if (!key || !given || given !== key) notFound();
  return <Plan2M />;
}
