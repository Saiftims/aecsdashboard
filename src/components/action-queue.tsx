import Link from "next/link";
import { Badge, Card, CardHeader } from "@/components/ui";
import type { QueueItem } from "@/lib/queries";

export function ActionQueue({ items, title }: { items: QueueItem[]; title: string }) {
  const buckets = new Map<string, QueueItem[]>();
  for (const it of items) {
    buckets.set(it.bucket, [...(buckets.get(it.bucket) ?? []), it]);
  }
  return (
    <Card>
      <CardHeader title={title} action={<Badge tone="blue">{items.length} items</Badge>} />
      {items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-zinc-400">Queue clear. Nice.</p>
      ) : (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {[...buckets.entries()].map(([bucket, rows]) => (
            <div key={bucket} className="px-4 py-3">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  {rows[0].priority}. {bucket}
                </span>
                <Badge>{rows.length}</Badge>
              </div>
              <ul className="space-y-1">
                {rows.slice(0, 8).map((r, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-3 text-sm">
                    <Link href={r.href} className="font-medium hover:underline">
                      {r.title}
                    </Link>
                    <span className="truncate text-xs text-zinc-500">{r.detail}</span>
                  </li>
                ))}
                {rows.length > 8 ? (
                  <li className="text-xs text-zinc-400">+{rows.length - 8} more</li>
                ) : null}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
