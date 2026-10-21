import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Badge, Callout, Card, CardBody, CardHeader, Cell, Empty, PageHeader, Section, Stat, StatGrid, Table,
  type BadgeTone, type Tone,
} from "@/components/ui";
import { RefreshButton } from "@/components/refresh-button";
import { currentAppUser } from "@/lib/supabase/server";
import { fmtAge, systemHealth, type Level } from "@/lib/system-health";

export const dynamic = "force-dynamic";

const BADGE: Record<Level, BadgeTone> = { ok: "green", warn: "yellow", bad: "red", unknown: "default" };
const TONE: Record<Level, Tone | undefined> = { ok: "good", warn: "warn", bad: "bad", unknown: undefined };
const WORD: Record<Level, string> = { ok: "OK", warn: "Check", bad: "Down", unknown: "No data" };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) + " UTC" : "—");

export default async function HealthPage() {
  const user = await currentAppUser();
  if (!user) redirect("/login");
  if (user.role !== "executive") redirect("/");

  const h = await systemHealth();
  const red = h.problems.filter((p) => p.level === "bad");
  const amber = h.problems.filter((p) => p.level === "warn");
  const failingChecks = h.checks.filter((c) => c.level !== "ok");
  const passingChecks = h.checks.filter((c) => c.level === "ok");

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Admin"
        title="System health"
        description={`Every feed, every table and every known data trap, checked ${when(h.generatedAt)}. Red items are posted to Slack when they change.`}
        actions={<div className="flex items-center gap-3"><Badge tone={BADGE[h.level]}>{h.level === "ok" ? "All systems OK" : `${red.length} red · ${amber.length} amber`}</Badge><RefreshButton /></div>}
      />

      {red.length || amber.length ? (
        <Callout tone={red.length ? "bad" : "warn"} title={red.length ? "Needs attention now" : "Worth a look"}>
          <ul className="list-disc space-y-1 pl-5">
            {[...red, ...amber].map((p, i) => <li key={i}>{p.text}</li>)}
          </ul>
        </Callout>
      ) : (
        <Callout tone="good" title="Nothing to do">Every feed ran on schedule, every table is growing, and no data-quality check has rows in it.</Callout>
      )}

      <Section title="Feeds" description="Scheduled syncs and when each last succeeded. A feed goes amber one missed cycle after its cadence and red after three.">
        <StatGrid cols={4}>
          {h.feeds.map((f) => (
            <Stat key={f.key} label={f.label} value={WORD[f.level]} tone={TONE[f.level]}
              sub={f.lastOkAt ? `last success ${fmtAge(f.ageMin)} · ${f.cadence}` : f.cadence} />
          ))}
        </StatGrid>
        <Card className="mt-4">
          <Table
            dense
            headers={["Feed", "Produces", "Cadence", "Last success", "Last run", "Note"]}
            rows={h.feeds.map((f) => [
              <Cell key="l"><span className="inline-flex items-center gap-2"><Badge tone={BADGE[f.level]}>{WORD[f.level]}</Badge>{f.label}</span></Cell>,
              f.what,
              f.cadence,
              <Cell key="ok" sub={f.lastOkAt ? when(f.lastOkAt) : undefined}>{fmtAge(f.ageMin)}</Cell>,
              <Cell key="run" sub={f.lastRunAt ? when(f.lastRunAt) : undefined}>{f.lastStatus ?? "—"}</Cell>,
              <span key="n" className="block max-w-md text-xs text-zinc-500 dark:text-zinc-400">
                {f.note}
                {f.lastError ? <span className="mt-0.5 block font-mono text-[11px] text-red-600 dark:text-red-400">{f.lastError.slice(0, 240)}</span> : null}
              </span>,
            ])}
          />
        </Card>
      </Section>

      <Section title="Freshness" description="The newest row in each table. A feed can run green and still write nothing - this is the second opinion.">
        <Card>
          <Table
            dense
            headers={["Table", "Newest row", "Age", "Why it matters"]}
            rows={h.watermarks.map((w) => [
              <Cell key="l"><span className="inline-flex items-center gap-2"><Badge tone={BADGE[w.level]}>{WORD[w.level]}</Badge>{w.label}</span></Cell>,
              when(w.latest),
              w.ageHours === null ? "never" : fmtAge(w.ageHours * 60),
              <span key="n" className="block max-w-xl text-xs text-zinc-500 dark:text-zinc-400">{w.note}</span>,
            ])}
          />
        </Card>
      </Section>

      <Section title="Data traps" description="Each check is a way the numbers have been wrong before. A non-zero count is a row that is being under- or mis-counted right now.">
        {failingChecks.length ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {failingChecks.map((c) => (
              <Card key={c.key}>
                <CardHeader title={c.label} description={c.why} action={<Badge tone={BADGE[c.level]}>{c.count}</Badge>} />
                <ul className="max-h-64 divide-y divide-zinc-100 overflow-y-auto text-sm dark:divide-zinc-800">
                  {c.examples.map((e) => (
                    <li key={e.id} className="flex items-baseline justify-between gap-3 px-4 py-1.5">
                      {e.href ? <Link href={e.href} className="truncate font-medium text-zinc-900 hover:underline dark:text-zinc-100">{e.label}</Link> : <span className="truncate font-medium">{e.label}</span>}
                      <span className="shrink-0 text-xs text-zinc-500">{e.detail}</span>
                    </li>
                  ))}
                  {c.count > c.examples.length ? <li className="px-4 py-1.5 text-xs text-zinc-400">+{c.count - c.examples.length} more</li> : null}
                </ul>
                <CardBody className="border-t border-zinc-100 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400"><span className="font-medium text-zinc-800 dark:text-zinc-200">Fix: </span>{c.fix}</CardBody>
              </Card>
            ))}
          </div>
        ) : <Empty>No check has rows in it.</Empty>}
        {passingChecks.length ? (
          <Card className="mt-4">
            <CardHeader title="Passing" />
            <div className="flex flex-wrap gap-2 p-4">
              {passingChecks.map((c) => <Badge key={c.key} tone="green" className="font-normal" >{c.label}</Badge>)}
            </div>
          </Card>
        ) : null}
      </Section>

      <Section title="Credentials" description="Tokens that expire. When one lapses the feed behind it stops with no error on our side.">
        <Card>
          <Table
            dense
            headers={["Token", "Expires", "Days left", "Note"]}
            rows={h.tokens.map((t) => [
              <Cell key="l"><span className="inline-flex items-center gap-2"><Badge tone={BADGE[t.level]}>{WORD[t.level]}</Badge>{t.label}</span></Cell>,
              t.expiresAt ? t.expiresAt.slice(0, 10) : "never",
              t.daysLeft === null ? "—" : String(t.daysLeft),
              <span key="n" className="block max-w-xl text-xs text-zinc-500 dark:text-zinc-400">{t.note}</span>,
            ])}
          />
        </Card>
      </Section>
    </div>
  );
}
