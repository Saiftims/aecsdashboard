import { Card, CardBody, CardHeader, Cell, Note, Table, TextLink } from "@/components/ui";
import { pctOf, type DemosPerLeadReport } from "@/lib/demos-per-lead";

/** "Demos per qualified lead" card: of the inbound leads the AE was given each
 * week, how many have a demo. Sits beside the AE activity chart. */
export function DemosPerLead({ report }: { report: DemosPerLeadReport }) {
  const r = report;
  const cur = r.current;
  const per10 = (rate: number | null) => (rate === null ? "—" : (rate * 10).toFixed(1));

  return (
    <Card>
      <CardHeader
        title="Demos per qualified lead — by week"
        action={
          r.ok && r.trailing.qualified
            ? <span>
                last {r.trailing.weeks} full weeks{" "}
                <strong className="text-zinc-800 dark:text-zinc-100">{pctOf(r.trailing.rate)}</strong>
                {" "}· {per10(r.trailing.rate)} demos per 10 leads
              </span>
            : undefined
        }
      />
      {!r.ok ? (
        <CardBody>
          <p className="text-sm text-zinc-500">HubSpot could not be read live, so the lead list is unavailable right now.</p>
        </CardBody>
      ) : (
          <>
            {cur ? (
              <CardBody className="pb-2">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <Tile value={pctOf(cur.rate)} label={`this week · ${cur.booked} of ${cur.qualified} leads`} />
                  <Tile value={String(cur.bookedByAe)} label="booked by the AE" />
                  <Tile value={String(cur.aeDemos)} label="AE demos this week, all leads" />
                </div>
              </CardBody>
            ) : null}
            <Table
              dense
              headers={["Week", "Qualified leads", "Demos", "Rate", "AE / self-serve", "AE demos (all)"]}
              rows={[...r.weeks].reverse().map((w) => [
                <Cell key="w" sub={w.partial ? "in progress" : undefined}>{w.label}</Cell>,
                w.qualified,
                w.booked,
                <strong key="r">{pctOf(w.rate)}</strong>,
                <Cell key="b" sub={w.otherOrPending ? `${w.otherOrPending} other / not yet credited` : undefined}>
                  {w.bookedByAe} / {w.selfServe}
                </Cell>,
                w.aeDemos,
              ])}
              empty="No qualified inbound leads in the last 8 weeks."
            />
          </>
      )}
      <Note>
        Qualified = FlyTech-qualified Meta fills, website form and wait list — the inbound leads the AE is
        meant to book; unqualified Meta fills, repeats and self-booked demos are not counted. A lead counts
        as a demo when its deal has a demo date or sits at Demo Scheduled or beyond, in the week the lead
        ARRIVED, so the newest weeks will still move. &ldquo;AE demos (all)&rdquo; is every demo credited
        to the AE that week whatever the lead&apos;s age.
        {" "}<TextLink href="/drill/demos_per_lead">Every qualified lead and whether it booked</TextLink>
      </Note>
    </Card>
  );
}

function Tile({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg bg-zinc-50 px-2 py-2 dark:bg-zinc-800/60">
      <div className="text-lg font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">{value}</div>
      <div className="text-[11px] text-zinc-500">{label}</div>
    </div>
  );
}
