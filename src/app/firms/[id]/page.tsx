import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { MonthlyBarChart } from "@/components/charts";
import { AcceptHandoffButton, FirmActions } from "@/components/firm-actions";
import { Badge, Card, CardHeader, Stat, Table, healthTone } from "@/components/ui";
import {
  ACTIVATION_STAGE_LABELS, hubspotCompanyUrl, hubspotDealUrl, type ActivationStage,
} from "@/lib/hubspot/stages";
import { monthlyCaseCounts } from "@/lib/metrics";
import { loadSettings } from "@/lib/settings";
import { currentAppUser, supabaseService } from "@/lib/supabase/server";
import type { CaseRecord } from "@/lib/cases/provider";

export const dynamic = "force-dynamic";

export default async function FirmPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await currentAppUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const sb = supabaseService();
  const settings = await loadSettings();

  const { data: company } = await sb.from("companies").select("*")
    .eq("hubspot_id", id).maybeSingle();
  if (!company) notFound();

  const [{ data: deals }, { data: contacts }, { data: activities },
         { data: mapping }, { data: owners }] = await Promise.all([
    sb.from("deals").select("*").eq("company_hubspot_id", id)
      .order("hs_created_at", { ascending: false }),
    sb.from("contacts").select("*").eq("company_hubspot_id", id),
    sb.from("activities").select("*").eq("company_hubspot_id", id)
      .order("occurred_at", { ascending: false }).limit(50),
    sb.from("firm_mapping").select("*").eq("hubspot_company_id", id).maybeSingle(),
    sb.from("app_users").select("hubspot_owner_id, full_name, email"),
  ]);

  let firmCases: CaseRecord[] = [];
  if (mapping) {
    const { data } = await sb.from("cases").select("*")
      .or(`sw_account_id.eq.${mapping.sw_account_id},sw_organization_id.eq.${mapping.sw_organization_id ?? "___"}`)
      .order("submitted_at", { ascending: true });
    firmCases = (data ?? []).map((c) => ({
      swId: c.sw_id, swAccountId: c.sw_account_id, swOrganizationId: c.sw_organization_id,
      name: c.name, caseStage: c.case_stage, analysisType: c.analysis_type,
      submittedAt: c.submitted_at, deliveredAt: c.delivered_at,
      reportStatus: c.report_status, raw: c.raw,
    }));
  }

  const salesDeal = (deals ?? []).find((d) => !d.activation_stage) ?? (deals ?? [])[0];
  const activationDeal = (deals ?? []).find((d) => d.activation_stage);
  const mainDeal = activationDeal ?? salesDeal;
  const champion = contacts?.find((c) => c.properties?.sw_champion_status === "active");
  const decisionMaker = contacts?.find((c) => c.properties?.sw_contact_role === "decision_maker");
  const monthly = monthlyCaseCounts(firmCases, 12);
  const healthFactors = (company.health_factors ?? []) as {
    label: string; points: number; earned: number;
  }[];
  const p = company.properties ?? {};
  // Server component rendered per-request (force-dynamic), so "now" is stable
  // for the lifetime of the render.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const daysSinceLastCase = company.last_case_at
    ? Math.floor((nowMs - new Date(company.last_case_at).getTime()) / 86400000)
    : null;
  const ownerOptions = (owners ?? [])
    .filter((o) => o.hubspot_owner_id)
    .map((o) => ({ id: o.hubspot_owner_id as string, label: o.full_name ?? o.email }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{company.name ?? company.domain}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-zinc-500">
            {mapping ? <Badge tone="blue">Firm ID: {mapping.sw_organization_id ?? mapping.sw_account_id}</Badge>
                     : <Badge tone="yellow">No firm mapping</Badge>}
            <span>HubSpot: {company.hubspot_id}</span>
            {activationDeal?.activation_stage ? (
              <Badge tone="blue">
                {ACTIVATION_STAGE_LABELS[activationDeal.activation_stage as ActivationStage]}
              </Badge>
            ) : salesDeal ? <Badge>{salesDeal.stage_label}</Badge> : null}
            {company.health_score !== null ? (
              <Badge tone={healthTone(company.health_category)}>
                Health {company.health_score} ({company.health_category})
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {activationDeal?.activation_stage === "handoff_pending" && user.role !== "ae" ? (
            <AcceptHandoffButton dealId={activationDeal.hubspot_id} />
          ) : null}
          <a
            href={hubspotCompanyUrl(settings.hubspotPortalId, company.hubspot_id)}
            target="_blank" rel="noreferrer"
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Open in HubSpot
          </a>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Stat label="Lifetime cases" value={company.cases_lifetime} />
        <Stat label="Cases 30d" value={company.cases_30d} />
        <Stat label="Cases 90d" value={company.cases_90d} />
        <Stat
          label="Days since last case"
          value={daysSinceLastCase ?? "-"}
          tone={daysSinceLastCase !== null && daysSinceLastCase > settings.atRiskInactivityDays
            ? "bad" : "good"}
        />
        <Stat label="Avg cases/month" value={company.avg_cases_per_month ?? "-"} />
        <Stat
          label="Est. revenue"
          value={`$${Math.round(company.est_revenue).toLocaleString()}`}
          sub={company.actual_revenue === null ? "estimated" : "actual available"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title="Cases by month" />
            <div className="p-4">
              {firmCases.length ? (
                <MonthlyBarChart data={monthly} />
              ) : (
                <p className="py-8 text-center text-sm text-zinc-400">
                  {mapping ? "No cases submitted yet" : "Map this firm in Settings to see case data"}
                </p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Deal history" />
            <Table
              headers={["Deal", "Stage", "Activation", "Owner", "Created"]}
              rows={(deals ?? []).map((d) => [
                <a key="a" href={hubspotDealUrl(settings.hubspotPortalId, d.hubspot_id)}
                   target="_blank" rel="noreferrer" className="hover:underline">
                  {d.name}
                </a>,
                d.stage_label ?? "-",
                d.activation_stage
                  ? ACTIVATION_STAGE_LABELS[d.activation_stage as ActivationStage] : "-",
                ownerOptions.find((o) => o.id === d.owner_id)?.label ?? d.owner_id ?? "-",
                d.hs_created_at ? new Date(d.hs_created_at).toLocaleDateString() : "-",
              ])}
            />
          </Card>

          <Card>
            <CardHeader title="Activity timeline (latest 50)" />
            <div className="max-h-96 divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800">
              {(activities ?? []).map((a) => (
                <div key={a.hubspot_id} className="px-4 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge tone={a.kind === "task" ? "yellow" : "default"}>{a.kind}</Badge>
                    {a.outcome ? <Badge tone="blue">{a.outcome}</Badge> : null}
                    <span className="text-xs text-zinc-400">
                      {a.occurred_at ? new Date(a.occurred_at).toLocaleString() : ""}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-zinc-600 dark:text-zinc-300">
                    {a.subject ?? stripHtml(a.body ?? "").slice(0, 180)}
                  </p>
                </div>
              ))}
              {!activities?.length ? (
                <p className="px-4 py-6 text-center text-sm text-zinc-400">No activity yet</p>
              ) : null}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <FirmActions
            role={user.role}
            companyId={company.hubspot_id}
            dealId={mainDeal?.hubspot_id}
            contactId={contacts?.[0]?.hubspot_id}
            currentStage={mainDeal?.stage ?? undefined}
            currentActivationStage={activationDeal?.activation_stage ?? undefined}
            owners={ownerOptions}
          />

          <Card>
            <CardHeader
              title="Contacts"
              action={<Badge>{contacts?.length ?? 0}</Badge>}
            />
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {(contacts ?? []).map((c) => {
                const name = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || c.email;
                const cp = c.properties ?? {};
                const role = cp.sw_contact_role as string | undefined;
                const isChampion = cp.sw_champion_status === "active";
                return (
                  <div key={c.hubspot_id} className="px-4 py-2.5 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{name}</span>
                      {isChampion ? <Badge tone="green">champion</Badge> : null}
                      {role && role !== "other" && !isChampion ? (
                        <Badge>{role.replaceAll("_", " ")}</Badge>
                      ) : null}
                    </div>
                    {cp.jobtitle ? (
                      <div className="text-xs text-zinc-500">{cp.jobtitle}</div>
                    ) : null}
                    <div className="mt-0.5 space-y-0.5 text-xs">
                      {c.email ? (
                        <div>
                          <a href={`mailto:${c.email}`} className="text-blue-600 hover:underline">
                            {c.email}
                          </a>
                        </div>
                      ) : null}
                      {cp.phone ? (
                        <div>
                          <a href={`tel:${cp.phone}`} className="text-blue-600 hover:underline">
                            {cp.phone}
                          </a>
                        </div>
                      ) : null}
                      {!c.email && !cp.phone ? (
                        <span className="text-zinc-400">no email / phone on record</span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {!contacts?.length ? (
                <p className="px-4 py-4 text-sm text-zinc-400">
                  No contacts on this firm yet - log a visit or add one in HubSpot.
                </p>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="Key people & next step" />
            <div className="space-y-1 p-4 text-sm">
              <Row k="Champion" v={champion ? `${champion.first_name ?? ""} ${champion.last_name ?? ""}` : p.sw_active_champion ?? "-"} />
              <Row k="Decision-maker" v={decisionMaker ? `${decisionMaker.first_name ?? ""} ${decisionMaker.last_name ?? ""}` : "-"} />
              <Row k="Est. monthly volume" v={p.sw_estimated_monthly_case_volume ?? "-"} />
              <Row k="Expansion potential" v={p.sw_expansion_potential ?? "-"} />
              <Row k="Next step" v={mainDeal?.properties?.sw_next_step ?? "-"} />
              <Row k="Next-step date" v={mainDeal?.properties?.sw_next_step_date ?? "-"} />
            </div>
          </Card>

          <Card>
            <CardHeader title="Health breakdown" />
            <div className="space-y-1.5 p-4 text-sm">
              {healthFactors.length ? healthFactors.map((f) => (
                <div key={f.label} className="flex items-center justify-between">
                  <span className={f.earned ? "" : "text-zinc-400"}>{f.label}</span>
                  <span className={f.earned ? "font-medium text-emerald-600" : "text-zinc-400"}>
                    {f.earned}/{f.points}
                  </span>
                </div>
              )) : <p className="text-zinc-400">Computed on next rollup sync</p>}
              {(company.risk_flags ?? []).length ? (
                <div className="mt-3 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                  <div className="mb-1 text-xs font-semibold uppercase text-zinc-500">Risk flags</div>
                  <div className="flex flex-wrap gap-1">
                    {company.risk_flags.map((f: string) => (
                      <Badge key={f} tone="red">{f}</Badge>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="Handoff summary" />
            <div className="p-4 text-sm whitespace-pre-wrap text-zinc-600 dark:text-zinc-300">
              {activationDeal?.properties?.sw_handoff_summary ?? "No handoff recorded."}
            </div>
          </Card>
        </div>
      </div>
      <p className="text-xs text-zinc-400">
        <Link href="/firms" className="hover:underline">&larr; All firms</Link>
      </p>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-zinc-500">{k}</span>
      <span className="text-right font-medium">{v || "-"}</span>
    </div>
  );
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
