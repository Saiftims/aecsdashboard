import { Card, CardBody, CardHeader, Note, TextLink } from "@/components/ui";
import { CHANNEL_WORD, fmtHours, type SpeedToLeadReport } from "@/lib/speed-to-lead";

/** "Speed to lead" card: how long inbound MQLs waited for a human call/text/DM.
 * Sits beside the AE activity chart on the Activity page. */
export function SpeedToLead({ report }: { report: SpeedToLeadReport }) {
  const r = report;
  const max = Math.max(1, ...r.buckets.map((b) => b.count), r.untouched.count);
  const pct = (n: number) => (r.total ? Math.round((n / r.total) * 100) : 0);
  const channels = (Object.keys(r.byChannel) as (keyof typeof r.byChannel)[])
    .filter((k) => r.byChannel[k] > 0)
    .map((k) => `${r.byChannel[k]} by ${CHANNEL_WORD[k].toLowerCase()}`).join(", ");

  return (
    <Card>
      <CardHeader
        title="Speed to lead — first human touch"
        action={
          r.ok && r.total
            ? <span>median <strong className="text-zinc-800 dark:text-zinc-100">{fmtHours(r.medianHours)}</strong> · {r.within.h1}% within 1h</span>
            : undefined
        }
      />
      <CardBody>
        {!r.ok ? (
          <p className="text-sm text-zinc-500">HubSpot could not be read live, so the lead list is unavailable right now.</p>
        ) : !r.total ? (
          <p className="text-sm text-zinc-500">No inbound leads in the last {r.days} days.</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-4 gap-2 text-center">
              {([["h1", "≤ 1h"], ["h3", "≤ 3h"], ["h6", "≤ 6h"], ["h24", "≤ 24h"]] as const).map(([k, label]) => (
                <div key={k} className="rounded-lg bg-zinc-50 px-2 py-2 dark:bg-zinc-800/60">
                  <div className="text-lg font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">{r.within[k]}%</div>
                  <div className="text-[11px] text-zinc-500">{label}</div>
                </div>
              ))}
            </div>
            <ul className="space-y-1.5">
              {r.buckets.map((b) => (
                <Bar key={b.key} label={b.label} count={b.count} max={max} pct={pct(b.count)} />
              ))}
              <Bar
                label="Not yet touched"
                count={r.untouched.count}
                max={max}
                pct={pct(r.untouched.count)}
                tone="warn"
                sub={r.untouched.count
                  ? `oldest waiting ${fmtHours(r.untouched.oldestHours)}${r.untouched.under1h ? ` · ${r.untouched.under1h} arrived under an hour ago` : ""}`
                  : undefined}
              />
            </ul>
            {r.byRep.length ? (
              <div className="text-xs text-zinc-500">
                First touch by{" "}
                {r.byRep.map((p, i) => (
                  <span key={p.ownerId}>
                    {i ? " · " : ""}
                    <strong className="text-zinc-700 dark:text-zinc-200">{p.name}</strong> {p.firsts} (median {fmtHours(p.medianHours)})
                  </span>
                ))}
                {channels ? <> · {channels}</> : null}
              </div>
            ) : null}
          </div>
        )}
      </CardBody>
      <Note>
        {r.total} inbound leads in the last {r.days} days (Meta form fills, website form, wait list — not
        self-booked demos, repeats or rep-added deals), timed from the form submission to the first call, text
        or DM by a person. Emails never count: the HubSpot sequences send under Alex&apos;s name and cannot be
        told from a typed one. Meetings are bookings, not touches. Clock time, not business hours.
        {" "}<TextLink href="/drill/speed_to_lead">Every lead with its first touch</TextLink>
      </Note>
    </Card>
  );
}

function Bar({ label, count, max, pct, tone, sub }: {
  label: string; count: number; max: number; pct: number; tone?: "warn"; sub?: string;
}) {
  return (
    <li className="grid grid-cols-[7.5rem_1fr_4.5rem] items-center gap-2 text-xs">
      <span className="text-zinc-600 dark:text-zinc-300">{label}</span>
      <span className="h-4 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
        <span
          className="block h-full rounded"
          style={{
            width: `${Math.max(count ? 3 : 0, (count / max) * 100)}%`,
            background: tone === "warn" ? "var(--chart-4)" : "var(--chart-1)",
          }}
        />
      </span>
      <span className="text-right tabular-nums text-zinc-700 dark:text-zinc-200">
        {count} <span className="text-zinc-400">· {pct}%</span>
        {sub ? <span className="block text-[10px] font-normal leading-tight text-zinc-400">{sub}</span> : null}
      </span>
    </li>
  );
}
