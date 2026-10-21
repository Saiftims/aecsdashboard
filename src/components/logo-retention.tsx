"use client";

import { useState } from "react";
import { Badge, Card, CardBody, CardHeader, Empty, Note, Pills, Table, TextLink } from "@/components/ui";
import { RetentionChart } from "@/components/charts";
import type { CohortRow } from "@/lib/queries";

type View = "subscription" | "transactional" | "all";

const LABEL: Record<View, string> = {
  subscription: "Subscriptions",
  transactional: "Transactional",
  all: "All firms",
};

/** "Cohort retention - still a customer", one billing model at a time.
 * Subscriptions are the default (owner, 2026-10-21: "i dont want to show
 * transactional, only subs"); the toggle switches to transactional firms or
 * to both together. A cohort with no firm of the selected kind is dropped
 * from the chart and table rather than drawn as an empty line. */
export function LogoRetention({
  cohorts, monthCols, partialMonthLabel,
}: {
  cohorts: CohortRow[];
  monthCols: number;
  partialMonthLabel: string | null;
}) {
  const [view, setView] = useState<View>("subscription");

  const rows = cohorts
    .map((c) => {
      const firms = view === "all" ? c.firms : view === "subscription" ? c.subscribers : c.transactional;
      const retention = view === "all" ? c.retention : c.retentionBy[view];
      return { ...c, firmsShown: firms, curve: retention };
    })
    .filter((c) => c.firmsShown > 0);

  const toggle = (
    <Pills
      size="xs"
      items={(["subscription", "transactional", "all"] as View[]).map((v) => ({
        key: v, label: LABEL[v], active: view === v, onClick: () => setView(v),
      }))}
    />
  );

  return (
    <>
      <Card>
        <CardHeader
          title={`Retention curve (% of ${view === "all" ? "cohort" : LABEL[view].toLowerCase()} still a customer)`}
          action={
            <div className="flex flex-wrap items-center gap-2">
              {partialMonthLabel ? (
                <Badge tone="yellow">
                  {partialMonthLabel} is still running — whichever month lands on it is understated
                </Badge>
              ) : null}
              {toggle}
            </div>
          }
        />
        <CardBody>
          {rows.length ? (
            <RetentionChart cohorts={rows.map((r) => ({ label: r.label, retention: r.curve }))} monthCols={monthCols} />
          ) : (
            <Empty>No {LABEL[view].toLowerCase()} cohorts yet.</Empty>
          )}
        </CardBody>
      </Card>
      <Card className="mt-3">
        <Table
          headers={["Cohort", "Firms", ...Array.from({ length: monthCols }, (_, m) => `Month ${m}`)]}
          rows={rows.map((c) => [
            <TextLink key="c" href={`/drill/cohort_${c.key}`} className="font-medium">
              {c.label}
            </TextLink>,
            view === "all" ? `${c.firms} · ${c.subscribers} sub · ${c.transactional} tx` : String(c.firmsShown),
            ...c.curve.map((r) => (r === null ? "—" : `${r}%`)),
          ])}
        />
      </Card>
      <Note className="px-0 pb-0">
        {view !== "transactional" ? (
          <>A subscriber is retained while the plan is live and churned the month they
          cancel {"\u2014"} sending cases does not keep them, and skipping a month does
          not lose them. A subscription cohort starts the month they subscribed.{" "}</>
        ) : null}
        {view !== "subscription" ? (
          <>A transactional firm is retained while it has submitted a case in the last
          90 days, and churned after 90 quiet days (not 30). A transactional cohort
          starts the month of their first case.{" "}</>
        ) : null}
        Month 0 is always 100%. &ldquo;—&rdquo; = that month hasn&apos;t elapsed yet.
        {partialMonthLabel ? ` The column landing on ${partialMonthLabel} is measured against an unfinished month.` : ""}{" "}
        Firms marked Trial in HubSpot are excluded here and from the retention charts
        below {"\u2014"} they never had a paying relationship to retain.
      </Note>
    </>
  );
}
