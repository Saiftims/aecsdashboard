import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { MonthlyBarChart } from "@/components/charts";
import { AcceptHandoffButton, FirmActions } from "@/components/firm-actions";
import { CaseWorkflow, type CaseItem } from "@/components/case-workflow";
import {
  Badge, Card, CardBody, CardHeader, Cell, Empty, PageHeader, Stat, StatGrid, Table, TextLink,
  healthTone,
} from "@/components/ui";
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

  // Cases now link directly to the company (case ingestion sets company_hubspot_id).
  const { data: caseRows } = await sb.from("cases")
    .select("case_id, case_name, case_status, submitted_date, delivered_date, " +
            "revenue_amount, expert_review_offered, expert_review_booked, " +
            "expert_review_completed, issue_flag, source")
    .eq("company_hubspot_id", id)
    .order("submitted_date", { ascending: true });
  const caseItems = (caseRows ?? []) as unknown as CaseItem[];
  const firmCases: CaseRecord[] = caseItems.map((c) => ({
    swId: c.case_id, swAccountId: null, swOrganizationId: null,
    name: c.case_name, caseStage: c.case_status, analysisType: null,
    submittedAt: c.submitted_date ?? new Date().toISOString(),
    deliveredAt: c.delivered_date, reportStatus: null, raw: c,
  }));

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
  const segment = company.firm_segment ?? (p.sw_firm_segment as string | null) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Firm"
        title={company.name ?? company.domain}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            {mapping ? <Badge tone="blue">Firm ID: {mapping.sw_organization_id ?? mapping.sw_account_id}</Badge>
                     : <Badge tone="yellow">No firm mapping</Badge>}
            <span>HubSpot: {company.hubspot_id}</span>
          </span>
        }
        actions={
          <>
            {company.health_score !== null ? (
              <Badge tone={healthTone(company.health_category)}>
                Health {company.health_score} ({company.health_category})
              </Badge>
            ) : null}
            {segment ? <Badge tone="violet">{segment.replace("_", " ")}</Badge> : null}
            {activationDeal?.activation_stage ? (
              <Badge tone="blue">
                {ACTIVATION_STAGE_LABELS[activationDeal.activation_stage as ActivationStage]}
              </Badge>
            ) : salesDeal ? <Badge>{salesDeal.stage_label}</Badge> : null}
            {activationDeal?.activation_stage === "handoff_pending" ? (
              <AcceptHandoffButton dealId={activationDeal.hubspot_id} />
            ) : null}
            <a
              href={hubspotCompanyUrl(settings.hubspotPortalId, company.hubspot_id)}
              target="_blank" rel="noreferrer"
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              Open in HubSpot
            </a>
          </>
        }
      />

      <StatGrid cols={6}>
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
      </StatGrid>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title="Cases by month" />
            {firmCases.length ? (
              <CardBody><MonthlyBarChart data={monthly} /></CardBody>
            ) : (
              <Empty>{mapping ? "No cases submitted yet" : "Map this firm in Settings to see case data"}</Empty>
            )}
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
            {activities?.length ? (
              <div className="max-h-96 divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800">
                {activities.map((a) => (
                  <div key={a.hubspot_id} className="px-4 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={a.kind === "task" ? "yellow" : "default"}>{a.kind}</Badge>
                      {a.outcome ? <Badge tone="blue">{a.outcome}</Badge> : null}
                      <span className="text-xs text-zinc-500">
                        {a.occurred_at ? new Date(a.occurred_at).toLocaleString() : ""}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-zinc-600 dark:text-zinc-300">
                      {a.subject ?? stripHtml(a.body ?? "").slice(0, 180)}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <Empty>No activity yet</Empty>
            )}
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

          <CaseWorkflow
            companyId={company.hubspot_id}
            segment={segment}
            monthlyTarget={company.monthly_case_target ?? null}
            cases={caseItems}
            canEdit
          />

          <Card>
            <CardHeader
              title="Contacts"
              action={<Badge>{contacts?.length ?? 0}</Badge>}
            />
            <Table
              dense
              headers={["Contact", "Reach"]}
              empty="No contacts on this firm yet - log a visit or add one in HubSpot."
              rows={(contacts ?? []).map((c) => {
                const name = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || c.email;
                const cp = c.properties ?? {};
                const role = cp.sw_contact_role as string | undefined;
                const isChampion = cp.sw_champion_status === "active";
                return [
                  <Cell key="n" sub={cp.jobtitle ? String(cp.jobtitle) : undefined}>
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span className="font-medium">{name}</span>
                      {isChampion ? <Badge tone="green">champion</Badge> : null}
                      {role && role !== "other" && !isChampion ? (
                        <Badge>{role.replaceAll("_", " ")}</Badge>
                      ) : null}
                    </span>
                  </Cell>,
                  <div key="r" className="space-y-0.5 text-xs">
                    {c.email ? <div><TextLink href={`mailto:${c.email}`}>{c.email}</TextLink></div> : null}
                    {cp.phone ? <div><TextLink href={`tel:${cp.phone}`}>{cp.phone}</TextLink></div> : null}
                    {!c.email && !cp.phone ? (
                      <span className="text-zinc-400">no email / phone on record</span>
                    ) : null}
                  </div>,
                ];
              })}
            />
          </Card>

          <Card>
            <CardHeader title="Key people & next step" />
            <CardBody className="space-y-1 text-sm">
              <Row k="Champion" v={champion ? `${champion.first_name ?? ""} ${champion.last_name ?? ""}` : p.sw_active_champion ?? "-"} />
              <Row k="Decision-maker" v={decisionMaker ? `${decisionMaker.first_name ?? ""} ${decisionMaker.last_name ?? ""}` : "-"} />
              <Row k="Est. monthly volume" v={p.sw_estimated_monthly_case_volume ?? "-"} />
              <Row k="Case volume tier" v={CASE_VOLUME_TIER_LABELS[String(p.sw_case_volume_tier ?? "")] ?? "-"} />
              <Row k="Expansion potential" v={p.sw_expansion_potential ?? "-"} />
              <Row k="Next step" v={mainDeal?.properties?.sw_next_step ?? "-"} />
              <Row k="Next-step date" v={mainDeal?.properties?.sw_next_step_date ?? "-"} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Health breakdown" />
            <CardBody className="space-y-1.5 text-sm">
              {healthFactors.length ? healthFactors.map((f) => (
                <div key={f.label} className="flex items-center justify-between">
                  <span className={f.earned ? "" : "text-zinc-400"}>{f.label}</span>
                  <span className={f.earned ? "font-medium tabular-nums text-emerald-600 dark:text-emerald-400" : "tabular-nums text-zinc-400"}>
                    {f.earned}/{f.points}
                  </span>
                </div>
              )) : <p className="text-zinc-400">Computed on next rollup sync</p>}
              {(company.risk_flags ?? []).length ? (
                <div className="mt-3 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Risk flags</div>
                  <div className="flex flex-wrap gap-1">
                    {company.risk_flags.map((f: string) => (
                      <Badge key={f} tone="red">{f}</Badge>
                    ))}
                  </div>
                </div>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Handoff summary" />
            <CardBody className="whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-300">
              {activationDeal?.properties?.sw_handoff_summary ?? "No handoff recorded."}
            </CardBody>
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

/** Labels for the sw_case_volume_tier picklist, which HubSpot stores as the
 * raw option value. Mirrors CASE_VOLUME_TIERS in hubspot_migration.py. */
const CASE_VOLUME_TIER_LABELS: Record<string, string> = {
  tier_1_10: "1-10 cases/mo",
  tier_11_25: "11-25 cases/mo",
  tier_26_50: "26-50 cases/mo",
  tier_51_100: "51-100 cases/mo",
  tier_101_200: "101-200 cases/mo",
  tier_200_plus: "200+ cases/mo",
  unknown: "Unknown",
};

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
