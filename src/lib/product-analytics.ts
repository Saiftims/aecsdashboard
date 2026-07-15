/** Live product analytics from PostHog, joined to Supabase customer firms.
 *
 * Windows:
 * - Product health: trailing 7 days
 * - Workflow, funnel, engagement, friction: trailing 30 days
 *
 * Important: this page measures PRODUCT telemetry only. Form/CSV intakes are
 * deliberately excluded. Missing instrumentation is returned as null so the UI
 * never presents an invented 0%.
 */
import { env } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/server";

type RawEvent = [
  event: string,
  email: string,
  accountId: string,
  sessionId: string,
  caseId: string,
  pathname: string,
  timestamp: string,
];

type AccountAggregate = [
  accountId: string,
  lastActive: string,
  activeUsers: number,
  sessions: number,
  caseStarts: number,
  caseSubmissions: number,
  reportsViewed: number,
  failures: number,
  groupName: string,
  sampleEmail: string,
];

type ReturningUserRow = [email: string, currentEvents: number, priorEvents: number];

interface CompanyProductRow {
  hubspot_id: string;
  name: string | null;
  domain: string | null;
  sw_account_id: string | null;
  signup_account_id: string | null;
}

interface ProductCase {
  email: string;
  accountId: string;
  startedAt: number;
  submittedAt: number | null;
  completedAt: number | null;
  analysisViewedAt: number | null;
  downloadedAt: number | null;
}

export interface ProductFunnelStep {
  label: string;
  count: number;
  conversion: number | null;
}

export interface ProductFirmRow {
  companyId: string | null;
  firm: string;
  lastActive: string | null;
  activeUsers: number;
  sessions30d: number;
  casesStarted: number;
  productCases30d: number;
  intakeCases30d: number;
  totalCases30d: number;
  reportsViewed: number;
  reportFailures: number;
  health: "healthy" | "watch" | "at_risk" | "not_using_product";
  healthReason: string;
}

export interface ProductDashboardData {
  generatedAt: string;
  health: {
    activeFirms7d: number;
    activeUsers7d: number;
    returningUserRate: number | null;
    medianSessionSeconds: number | null;
    sessionsPerActiveFirm: number | null;
  };
  workflow: {
    caseStarts: number;
    productCases30d: number;
    intakeCases30d: number;
    caseCompletionRate: number | null;
    medianTimeToSubmitSeconds: number | null;
    analysisViewRate: number | null;
    reportDownloadRate: number | null;
  };
  funnel: ProductFunnelStep[];
  firms: ProductFirmRow[];
  friction: {
    failedLoginRate: null;
    forgotPasswordRequests: null;
    uploadFailureRate: null;
    submissionErrors: null;
    repeatedErrorUsers: number;
    reportGenerationFailureRate: number | null;
  };
  instrumentationNotes: string[];
}

const DAY = 86400000;
const TEST_ACCOUNT_IDS = [
  "acc_288f6554fd2e4e0d850a734d25f2f799",
  "acc_f5bc1fb1e0584f5f9b03435769d6c37a",
  "acc_d9a5094383384e00a5aafb15225d5f78",
  "acc_3f97023cbf544874b818a721bbab946a",
  "acc_c3c2b0d29ae64e7e9d0f1f92a6d8616d",
];

const REAL_USER_PREDICATE = `
  person.properties.email is not null
  and not endsWith(lower(toString(person.properties.email)), '@silentwitness.ai')
  and lower(toString(person.properties.email)) not like 'saif+%'
  and lower(toString(person.properties.email)) not like 'diego+%'
  and lower(toString(person.properties.email)) not like 'diegodf+%'
  and lower(toString(person.properties.email)) not in (
    'diegodf@gmail.com','sheikhrobertomanagement@gmail.com',
    'saif.altimims@gmail.com','asdf@das.es','me@damidina.com'
  )
  and coalesce(toString(properties.$group_0), '') not in (
    ${TEST_ACCOUNT_IDS.map((id) => `'${id}'`).join(",")}
  )
`;

async function posthogQuery<T>(sql: string): Promise<T[]> {
  const response = await fetch(
    `${env.posthogHost().replace(/\/$/, "")}/api/projects/${env.posthogProjectId()}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.posthogKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: sql } }),
      cache: "no-store",
    },
  );
  if (!response.ok) {
    throw new Error(`PostHog product query -> ${response.status}: ${await response.text()}`);
  }
  const data = (await response.json()) as { results?: T[] };
  return data.results ?? [];
}

function domainOf(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function pct(numerator: number, denominator: number): number | null {
  return denominator ? Math.round((numerator / denominator) * 100) : null;
}

function caseIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/cases\/(case_[a-zA-Z0-9]+)(?:\/|$)/);
  return match?.[1] ?? null;
}

function healthForFirm(
  lastActive: string | null,
  productCasesLifetime: number,
  intakeCasesLifetime: number,
  failures: number,
  now: Date,
): { health: ProductFirmRow["health"]; reason: string } {
  if (intakeCasesLifetime > 0 && productCasesLifetime === 0) {
    return {
      health: "not_using_product",
      reason: `${intakeCasesLifetime} intake case(s), 0 product-created cases`,
    };
  }
  if (!lastActive) {
    return { health: "at_risk", reason: "No product activity recorded" };
  }
  const days = Math.floor((now.getTime() - new Date(lastActive).getTime()) / DAY);
  if (failures >= 3) {
    return { health: "at_risk", reason: `${failures} report failures in 30d` };
  }
  if (days > 14) return { health: "at_risk", reason: `Inactive ${days} days` };
  if (days > 7) return { health: "watch", reason: `Last active ${days} days ago` };
  if (failures > 0) return { health: "watch", reason: `${failures} report failure(s)` };
  if (productCasesLifetime === 0) {
    return { health: "watch", reason: "Active, no product-created case" };
  }
  return { health: "healthy", reason: "Recently active with submitted case" };
}

export async function productDashboard(): Promise<ProductDashboardData> {
  const sb = supabaseService();
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY);
  const [sessionHealth, returningRows, accountRows, rawEvents, companiesResult,
    mappingsResult, casesResult] =
    await Promise.all([
      posthogQuery<[number, number, number, number | null]>(`
        select count(), count(distinct account_id), count(distinct email),
               median(duration_seconds)
        from (
          select properties.$session_id as session_id,
                 max(toString(properties.$group_0)) as account_id,
                 max(lower(toString(person.properties.email))) as email,
                 dateDiff('second', min(timestamp), max(timestamp)) as duration_seconds
          from events
          where timestamp > now() - interval 7 day
            and properties.$session_id is not null and ${REAL_USER_PREDICATE}
          group by properties.$session_id
          having duration_seconds >= 0 and duration_seconds <= 14400
        )
      `),
      posthogQuery<ReturningUserRow>(`
        select lower(toString(person.properties.email)) as email,
               countIf(timestamp >= now() - interval 7 day) as current_events,
               countIf(timestamp < now() - interval 7 day) as prior_events
        from events
        where timestamp > now() - interval 14 day and ${REAL_USER_PREDICATE}
        group by email
      `),
      posthogQuery<AccountAggregate>(`
        select toString(properties.$group_0) as account_id,
               max(timestamp) as last_active,
               count(distinct lower(toString(person.properties.email))) as active_users,
               count(distinct properties.$session_id) as sessions,
               count(distinct if(event = 'case_created', toString(properties.caseId), null)) as case_starts,
               count(distinct if(event = 'file_uploaded', toString(properties.caseId), null)) as case_submissions,
               count(distinct if(
                 event = '$pageview'
                 and endsWith(trimRight(toString(properties.$pathname), '/'), '/report'),
                 toString(properties.$pathname), null
               )) as reports_viewed,
               countIf(event = 'report_generation_failed') as failures,
               max(if(event = '$groupidentify', toString(properties.$group_set.name), '')) as group_name,
               max(lower(toString(person.properties.email))) as sample_email
        from events
        where timestamp > now() - interval 30 day
          and properties.$group_0 is not null and ${REAL_USER_PREDICATE}
        group by account_id order by last_active desc
      `),
      posthogQuery<RawEvent>(`
        select event, lower(toString(person.properties.email)),
               toString(properties.$group_0), toString(properties.$session_id),
               toString(properties.caseId), toString(properties.$pathname), timestamp
        from events
        where timestamp > now() - interval 30 day and ${REAL_USER_PREDICATE}
          and event in (
            '$identify','$pageview','case_created','file_uploaded',
            'report_generation_completed','report_generation_failed','report_downloaded'
          )
        order by timestamp asc limit 10000
      `),
      sb.from("companies").select(
        "hubspot_id,name,domain,sw_account_id,signup_account_id",
      ),
      sb.from("firm_mapping").select(
        "sw_account_id,sw_organization_id,hubspot_company_id",
      ),
      sb.from("cases").select(
        "company_hubspot_id,source,case_status,submitted_date",
      ),
    ]);

  const companies = (companiesResult.data ?? []) as CompanyProductRow[];
  const companyById = new Map(companies.map((c) => [c.hubspot_id, c]));
  const companyByDomain = new Map(
    companies.filter((c) => c.domain).map((c) => [c.domain!.toLowerCase(), c]),
  );
  const companyByName = new Map(
    companies.filter((c) => c.name).map((c) => [normalize(c.name), c]),
  );
  const companyByAccount = new Map<string, CompanyProductRow>();
  for (const c of companies) {
    if (c.sw_account_id) companyByAccount.set(c.sw_account_id, c);
    if (c.signup_account_id) companyByAccount.set(c.signup_account_id, c);
  }
  for (const mapping of mappingsResult.data ?? []) {
    const company = companyById.get(mapping.hubspot_company_id);
    if (!company) continue;
    if (mapping.sw_account_id) companyByAccount.set(mapping.sw_account_id, company);
    if (mapping.sw_organization_id) companyByAccount.set(mapping.sw_organization_id, company);
  }

  const resolveCompany = (
    accountId: string,
    sampleEmail: string,
    groupName: string,
  ): CompanyProductRow | null => {
    const direct = companyByAccount.get(accountId);
    if (direct) return direct;
    const domain = domainOf(sampleEmail);
    if (domain && companyByDomain.has(domain)) return companyByDomain.get(domain)!;
    const normalizedName = normalize(groupName);
    if (normalizedName && companyByName.has(normalizedName)) return companyByName.get(normalizedName)!;
    return null;
  };

  // Reconciled case usage from every channel. PostHog + manually reconciled app
  // cases count as product-created; intake_form/hubspot_intake are form usage.
  const intakeSources = new Set(["intake_form", "hubspot_intake"]);
  const caseUsage = new Map<string, {
    product30d: number;
    intake30d: number;
    productLifetime: number;
    intakeLifetime: number;
  }>();
  let productCases30d = 0;
  let intakeCases30d = 0;
  for (const row of casesResult.data ?? []) {
    if (!row.company_hubspot_id || row.case_status === "cancelled") continue;
    const usage = caseUsage.get(row.company_hubspot_id) ?? {
      product30d: 0, intake30d: 0, productLifetime: 0, intakeLifetime: 0,
    };
    const isIntake = intakeSources.has(row.source ?? "");
    const isRecent = Boolean(
      row.submitted_date && new Date(row.submitted_date) >= thirtyDaysAgo,
    );
    if (isIntake) {
      usage.intakeLifetime += 1;
      if (isRecent) {
        usage.intake30d += 1;
        intakeCases30d += 1;
      }
    } else {
      usage.productLifetime += 1;
      if (isRecent) {
        usage.product30d += 1;
        productCases30d += 1;
      }
    }
    caseUsage.set(row.company_hubspot_id, usage);
  }

  // Merge multiple PostHog account IDs that resolve to one customer firm.
  const merged = new Map<string, {
    company: CompanyProductRow | null;
    name: string;
    lastActive: string;
    activeUsers: number;
    sessions: number;
    starts: number;
    submissions: number;
    reportsViewed: number;
    failures: number;
    productCases30d: number;
    intakeCases30d: number;
    productCasesLifetime: number;
    intakeCasesLifetime: number;
  }>();
  for (const row of accountRows) {
    const [accountId, lastActive, users, sessions, starts, submissions, viewed,
      failures, groupName, email] = row;
    const company = resolveCompany(accountId, email, groupName);
    const key = company?.hubspot_id ?? accountId;
    const existing = merged.get(key);
    const name = company?.name ?? (groupName || domainOf(email) || accountId);
    const reconciled = company ? caseUsage.get(company.hubspot_id) : null;
    merged.set(key, {
      company,
      name,
      lastActive: existing && existing.lastActive > lastActive ? existing.lastActive : lastActive,
      activeUsers: (existing?.activeUsers ?? 0) + Number(users),
      sessions: (existing?.sessions ?? 0) + Number(sessions),
      starts: (existing?.starts ?? 0) + Number(starts),
      submissions: (existing?.submissions ?? 0) + Number(submissions),
      reportsViewed: (existing?.reportsViewed ?? 0) + Number(viewed),
      failures: (existing?.failures ?? 0) + Number(failures),
      productCases30d: reconciled?.product30d ?? existing?.productCases30d ?? 0,
      intakeCases30d: reconciled?.intake30d ?? existing?.intakeCases30d ?? 0,
      productCasesLifetime:
        reconciled?.productLifetime ?? existing?.productCasesLifetime ?? 0,
      intakeCasesLifetime:
        reconciled?.intakeLifetime ?? existing?.intakeCasesLifetime ?? 0,
    });
  }

  // Include case-using firms even when PostHog has no account/activity for them.
  for (const [companyId, usage] of caseUsage) {
    if (merged.has(companyId)) continue;
    const company = companyById.get(companyId);
    if (!company) continue;
    merged.set(companyId, {
      company,
      name: company.name ?? company.domain ?? companyId,
      lastActive: "",
      activeUsers: 0,
      sessions: 0,
      starts: 0,
      submissions: 0,
      reportsViewed: 0,
      failures: 0,
      productCases30d: usage.product30d,
      intakeCases30d: usage.intake30d,
      productCasesLifetime: usage.productLifetime,
      intakeCasesLifetime: usage.intakeLifetime,
    });
  }

  const firms: ProductFirmRow[] = [...merged.values()].map((row) => {
    const status = healthForFirm(
      row.lastActive || null,
      row.productCasesLifetime,
      row.intakeCasesLifetime,
      row.failures,
      now,
    );
    return {
      companyId: row.company?.hubspot_id ?? null,
      firm: row.name,
      lastActive: row.lastActive || null,
      activeUsers: row.activeUsers,
      sessions30d: row.sessions,
      casesStarted: row.starts,
      productCases30d: row.productCases30d,
      intakeCases30d: row.intakeCases30d,
      totalCases30d: row.productCases30d + row.intakeCases30d,
      reportsViewed: row.reportsViewed,
      reportFailures: row.failures,
      health: status.health,
      healthReason: status.reason,
    };
  }).sort((a, b) => (b.lastActive ?? "").localeCompare(a.lastActive ?? ""));

  const activeFirms7d = firms.filter(
    (f) => f.lastActive
      && now.getTime() - new Date(f.lastActive).getTime() <= 7 * DAY,
  ).length;
  const [sessions7d = 0, , activeUsers7d = 0, medianDuration = null] =
    sessionHealth[0] ?? [];
  const currentUsers = returningRows.filter((r) => Number(r[1]) > 0);
  const returningUsers = currentUsers.filter((r) => Number(r[2]) > 0);

  const cases = new Map<string, ProductCase>();
  const loginUsers = new Set<string>();
  const reportFailuresByUser = new Map<string, number>();
  for (const [event, email, accountId, , caseId, pathname, timestamp] of rawEvents) {
    const time = new Date(timestamp).getTime();
    if (event === "$identify" && email) loginUsers.add(email);
    if (event === "report_generation_failed" && email) {
      reportFailuresByUser.set(email, (reportFailuresByUser.get(email) ?? 0) + 1);
    }
    if (event === "case_created" && caseId) {
      const existing = cases.get(caseId);
      cases.set(caseId, {
        email,
        accountId,
        startedAt: existing?.startedAt ? Math.min(existing.startedAt, time) : time,
        submittedAt: existing?.submittedAt ?? null,
        completedAt: existing?.completedAt ?? null,
        analysisViewedAt: existing?.analysisViewedAt ?? null,
        downloadedAt: existing?.downloadedAt ?? null,
      });
      continue;
    }
    if (event === "$pageview") {
      const pathCaseId = caseIdFromPath(pathname);
      const existing = pathCaseId ? cases.get(pathCaseId) : null;
      if (
        existing && pathname.replace(/\/$/, "").endsWith("/report")
        && (!existing.analysisViewedAt || time < existing.analysisViewedAt)
      ) {
        existing.analysisViewedAt = time;
      }
      continue;
    }
    const existing = caseId ? cases.get(caseId) : null;
    if (!existing) continue; // funnel cohort = cases started during the window
    if (event === "file_uploaded" && (!existing.submittedAt || time < existing.submittedAt)) {
      existing.submittedAt = time;
    }
    if (
      event === "report_generation_completed"
      && (!existing.completedAt || time < existing.completedAt)
    ) {
      existing.completedAt = time;
    }
    if (event === "report_downloaded" && (!existing.downloadedAt || time < existing.downloadedAt)) {
      existing.downloadedAt = time;
    }
  }

  const startedCases = [...cases.values()];
  const submittedCases = startedCases.filter((c) => c.submittedAt !== null);
  const completedCases = startedCases.filter((c) => c.completedAt !== null);
  const viewedCases = completedCases.filter(
    (c) => c.analysisViewedAt !== null && c.analysisViewedAt! >= c.completedAt!,
  );
  const downloadedCases = completedCases.filter((c) => c.downloadedAt !== null);
  const submitDurations = submittedCases
    .map((c) => (c.submittedAt! - c.startedAt) / 1000)
    .filter((seconds) => seconds >= 0 && seconds <= 7 * 86400);

  // User-based, sequential funnel: every stage is a subset of the prior stage.
  const startedUsers = new Set(
    startedCases.map((c) => c.email).filter((email) => loginUsers.has(email)),
  );
  const submittedUsers = new Set(
    submittedCases.map((c) => c.email).filter((email) => startedUsers.has(email)),
  );
  const viewedUsers = new Set(
    viewedCases.map((c) => c.email).filter((email) => submittedUsers.has(email)),
  );
  const downloadedUsers = new Set(
    downloadedCases.map((c) => c.email).filter((email) => viewedUsers.has(email)),
  );
  const funnelCounts: [string, number][] = [
    ["Login / active user", loginUsers.size],
    ["Case started", startedUsers.size],
    ["Case submitted", submittedUsers.size],
    ["Analysis viewed", viewedUsers.size],
    ["Report downloaded", downloadedUsers.size],
  ];
  const funnel = funnelCounts.map(([label, count], index) => ({
    label,
    count,
    conversion: index === 0 ? null : pct(count, funnelCounts[index - 1][1]),
  }));

  const failedCaseIds = new Set(
    rawEvents.filter((r) => r[0] === "report_generation_failed" && r[4]).map((r) => r[4]),
  );
  const attemptedCaseIds = new Set(
    rawEvents
      .filter((r) => ["report_generation_failed", "report_generation_completed"].includes(r[0]) && r[4])
      .map((r) => r[4]),
  );

  return {
    generatedAt: now.toISOString(),
    health: {
      activeFirms7d,
      activeUsers7d: Number(activeUsers7d),
      returningUserRate: pct(returningUsers.length, currentUsers.length),
      medianSessionSeconds: medianDuration === null ? null : Math.round(Number(medianDuration)),
      sessionsPerActiveFirm: activeFirms7d
        ? Math.round((Number(sessions7d) / activeFirms7d) * 10) / 10
        : null,
    },
    workflow: {
      caseStarts: startedCases.length,
      productCases30d,
      intakeCases30d,
      caseCompletionRate: pct(completedCases.length, startedCases.length),
      medianTimeToSubmitSeconds: median(submitDurations),
      analysisViewRate: pct(viewedCases.length, completedCases.length),
      reportDownloadRate: pct(downloadedCases.length, completedCases.length),
    },
    funnel,
    firms,
    friction: {
      failedLoginRate: null,
      forgotPasswordRequests: null,
      uploadFailureRate: null,
      submissionErrors: null,
      repeatedErrorUsers: [...reportFailuresByUser.values()].filter((n) => n >= 2).length,
      reportGenerationFailureRate: pct(failedCaseIds.size, attemptedCaseIds.size),
    },
    instrumentationNotes: [
      "PostHog does not emit login_failed, forgot_password_requested, upload_failed, or submission_error.",
      "Case submitted uses first file_uploaded after case_created as the available proxy.",
      "Analysis viewed requires a /cases/{id}/report page view after report completion.",
      "This page measures in-product activity only; intake-form/CSV cases are excluded.",
      "case_created is known to under-report some app cases, so workflow counts are a telemetry floor.",
    ],
  };
}
