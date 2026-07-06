import { redirect } from "next/navigation";
import { MappingEditor, SettingField, SyncButton } from "@/components/admin-widgets";
import { Badge, Card, CardHeader, Table } from "@/components/ui";
import { loadSettings } from "@/lib/settings";
import { currentAppUser, supabaseService } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await currentAppUser();
  if (!user) redirect("/login");
  if (user.role !== "executive") redirect("/");

  const sb = supabaseService();
  const settings = await loadSettings();
  const [{ data: companies }, { data: mappings }, { data: syncs }, { data: cases }] =
    await Promise.all([
      sb.from("companies").select("hubspot_id, name, domain").order("name"),
      sb.from("firm_mapping").select("*"),
      sb.from("sync_runs").select("*").order("started_at", { ascending: false }).limit(15),
      sb.from("cases").select("sw_account_id, sw_organization_id"),
    ]);

  const mappingByCompany = new Map((mappings ?? []).map((m) => [m.hubspot_company_id, m]));
  const swIds = [...new Set(
    (cases ?? []).flatMap((c) => [c.sw_organization_id, c.sw_account_id]).filter(Boolean),
  )] as string[];
  const swOptions = swIds.map((id) => ({ id, label: id }));
  const lastOk = (syncs ?? []).find((s) => s.status === "ok");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Admin Settings</h1>
        <div className="flex items-center gap-2">
          <SyncButton />
          <SyncButton full />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Business thresholds" />
          <div className="space-y-3 p-4">
            <SettingField settingKey="default_case_price" label="Default case price ($)" defaultValue={settings.defaultCasePrice} />
            <SettingField settingKey="first_case_target_days" label="First-case target (days after closed won)" defaultValue={settings.firstCaseTargetDays} />
            <SettingField settingKey="second_case_target_days" label="Second-case target (days)" defaultValue={settings.secondCaseTargetDays} />
            <SettingField settingKey="at_risk_inactivity_days" label="At-risk inactivity threshold (days)" defaultValue={settings.atRiskInactivityDays} />
            <SettingField settingKey="healthy_cases_per_30d" label="Healthy account: cases per 30 days" defaultValue={settings.healthyCasesPer30d} />
            <SettingField settingKey="stalled_deal_days" label="Stalled deal threshold (days without touch)" defaultValue={settings.stalledDealDays} />
          </div>
        </Card>

        <Card>
          <CardHeader title="AE daily targets" />
          <div className="space-y-3 p-4">
            <SettingField settingKey="daily_calls_target" label="Calls per day" defaultValue={settings.dailyCallsTarget} />
            <SettingField settingKey="daily_emails_target" label="Emails per day" defaultValue={settings.dailyEmailsTarget} />
            <SettingField settingKey="daily_followups_target" label="Follow-ups completed per day" defaultValue={settings.dailyFollowupsTarget} />
            <SettingField settingKey="daily_new_leads_target" label="New leads contacted per day (fallback when none arrive)" defaultValue={settings.dailyNewLeadsTarget} />
            <SettingField settingKey="daily_tasks_target" label="Tasks completed per day" defaultValue={settings.dailyTasksTarget} />
            <SettingField settingKey="sla_first_contact_hours" label="First-contact SLA (hours)" defaultValue={settings.slaFirstContactHours} />
            <SettingField settingKey="dashboard_timezone" label="Dashboard timezone (day boundaries)" defaultValue={settings.dashboardTimezone} type="text" />
          </div>
        </Card>

        <Card>
          <CardHeader title="HubSpot" />
          <div className="space-y-3 p-4">
            <SettingField settingKey="hubspot_portal_id" label="Portal ID" defaultValue={settings.hubspotPortalId} type="text" />
            <SettingField settingKey="hubspot_sales_pipeline_id" label="Sales pipeline ID" defaultValue={settings.hubspotSalesPipelineId} type="text" />
            <p className="text-xs text-zinc-500">
              AE/CS weekly targets and scorecard weights live in the settings table
              (keys <code>ae_weekly_targets</code>, <code>cs_targets</code>,
              <code>ae_scorecard_weights</code>, <code>cs_scorecard_weights</code>)
              and are editable via the API or Supabase Studio.
            </p>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Firm mapping (Silent Witness -> HubSpot company)"
          action={<Badge tone={mappingByCompany.size ? "green" : "yellow"}>{mappingByCompany.size} mapped</Badge>}
        />
        <div className="space-y-2 p-4">
          <p className="text-xs text-zinc-500">
            Map each customer firm once using its stable Silent Witness id (never by
            name). Unmapped firms with case data appear in Data Quality. Optional
            per-firm price overrides the default case price.
          </p>
          {(companies ?? []).map((c) => {
            const m = mappingByCompany.get(c.hubspot_id);
            return (
              <MappingEditor
                key={c.hubspot_id}
                hubspotCompanyId={c.hubspot_id}
                companyName={c.name ?? c.domain ?? c.hubspot_id}
                current={m ? {
                  swAccountId: m.sw_account_id,
                  swOrganizationId: m.sw_organization_id,
                  perCasePrice: m.per_case_price,
                } : undefined}
                swOptions={swOptions}
              />
            );
          })}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Sync status"
          action={lastOk ? (
            <span className="text-xs text-zinc-500">
              Last OK: {new Date(lastOk.finished_at).toLocaleString()}
            </span>
          ) : undefined}
        />
        <Table
          headers={["Kind", "Status", "Started", "Finished", "Stats / error"]}
          rows={(syncs ?? []).map((s) => [
            s.kind,
            <Badge key="b" tone={s.status === "ok" ? "green" : s.status === "error" ? "red" : "yellow"}>
              {s.status}
            </Badge>,
            new Date(s.started_at).toLocaleString(),
            s.finished_at ? new Date(s.finished_at).toLocaleString() : "-",
            s.error ?? JSON.stringify(s.stats),
          ])}
        />
      </Card>
    </div>
  );
}
