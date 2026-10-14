import { redirect } from "next/navigation";
import { SubscribersTable } from "@/components/subscribers-table";
import { subscribersReport } from "@/lib/subscribers";
import { currentAppUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function SubscribersPage() {
  const user = await currentAppUser();
  if (!user) redirect("/login");
  if (user.role !== "executive" && user.role !== "cs") redirect("/");
  const { rows, syncedAt } = await subscribersReport();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Subscribers</h1>
        <p className="text-sm text-zinc-500">
          Every firm on a plan: what they are on, when it renews, and how many included cases they have left this period.
          {syncedAt ? ` Stripe synced ${new Date(syncedAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" })} PT.` : ""}
        </p>
      </div>
      <SubscribersTable rows={rows} />
    </div>
  );
}
