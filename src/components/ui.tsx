/** The dashboard's UI kit (Tailwind v4). Every page composes these; nothing
 * hand-rolls a card, table, pill row or form control. Colours come from the
 * tokens in globals.css so light and dark stay in step. */
import { clsx } from "clsx";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { HTMLAttributes, ReactNode } from "react";

// ---------------------------------------------------------------------------
// Page scaffolding
// ---------------------------------------------------------------------------

/** Title row at the top of every page: h1, optional one-line description,
 * optional actions on the right (filters, links, buttons). */
export function PageHeader({ title, description, actions, eyebrow }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1 text-xs font-medium uppercase tracking-wider text-zinc-500">{eyebrow}</div> : null}
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 md:text-2xl">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-sm text-zinc-500 dark:text-zinc-400">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A titled group of tiles or cards. */
export function Section({ title, description, action, children, className }: {
  title: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={className}>
      <div className="mb-2 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-zinc-400">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Responsive tile grid. `cols` is the count at desktop width. */
export function StatGrid({ cols = 5, children }: { cols?: 2 | 3 | 4 | 5 | 6; children: ReactNode }) {
  return (
    <div className={clsx("grid grid-cols-2 gap-3", {
      "md:grid-cols-2": cols === 2,
      "md:grid-cols-3": cols === 3,
      "md:grid-cols-4": cols === 4,
      "md:grid-cols-3 lg:grid-cols-5": cols === 5,
      "md:grid-cols-3 lg:grid-cols-6": cols === 6,
    })}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx(
        "rounded-xl border border-zinc-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-zinc-800 dark:bg-zinc-900",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ title, description, action }: {
  title: ReactNode; description?: ReactNode; action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{title}</h3>
        {description ? <p className="mt-0.5 text-xs text-zinc-500">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2 text-xs text-zinc-500">{action}</div> : null}
    </div>
  );
}

/** Body padding for a card that holds a chart or prose. */
export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx("p-4", className)} {...props} />;
}

/** Small-print explanation under a table or chart. One per card at most. */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={clsx("px-4 pb-3 pt-2 text-xs leading-relaxed text-zinc-400 dark:text-zinc-500", className)}>
      {children}
    </p>
  );
}

export function Empty({ children = "Nothing here" }: { children?: ReactNode }) {
  return <div className="px-4 py-8 text-center text-sm text-zinc-400">{children}</div>;
}

/** Inline callout. `tone` warn for degraded data, bad for failures. */
export function Callout({ tone = "info", title, children }: {
  tone?: "info" | "warn" | "bad" | "good"; title?: ReactNode; children: ReactNode;
}) {
  return (
    <div className={clsx("rounded-xl border px-4 py-3 text-sm", {
      "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-100": tone === "info",
      "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100": tone === "warn",
      "border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100": tone === "bad",
      "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-100": tone === "good",
    })}>
      {title ? <div className="font-semibold">{title}</div> : null}
      <div className={clsx(title && "mt-0.5", "text-[13px] leading-relaxed opacity-90")}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

export type Tone = "good" | "warn" | "bad";

const TONE_TEXT: Record<Tone, string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-red-600 dark:text-red-400",
};

export function Stat({ label, value, sub, tone, href }: {
  label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; href?: string;
}) {
  const inner = (
    <Card className={clsx("group relative px-4 py-3",
      href && "transition hover:border-zinc-300 hover:shadow-md dark:hover:border-zinc-700")}>
      <div className="flex items-start justify-between gap-2">
        <div className="truncate text-[11px] font-medium uppercase tracking-wider text-zinc-500">{label}</div>
        {href ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-300 transition group-hover:text-zinc-500" /> : null}
      </div>
      <div className={clsx("mt-1 text-2xl font-semibold tabular-nums tracking-tight", tone ? TONE_TEXT[tone] : "text-zinc-900 dark:text-zinc-50")}>
        {value}
      </div>
      {sub ? <div className="mt-0.5 truncate text-xs text-zinc-500" title={typeof sub === "string" ? sub : undefined}>{sub}</div> : null}
    </Card>
  );
  return href ? <Link href={href} className="block">{inner}</Link> : inner;
}

/** Daily target card: "Calls today 8 / 30" with a progress bar. */
export function TargetCard({ label, value, target, sub, href }: {
  label: string; value: number; target: number; sub?: string; href?: string;
}) {
  const pct = target > 0 ? Math.min(Math.round((value / target) * 100), 100) : 0;
  const done = target > 0 && value >= target;
  const inner = (
    <Card className={clsx("px-4 py-3", href && "transition hover:border-zinc-300 hover:shadow-md dark:hover:border-zinc-700")}>
      <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className={clsx("text-2xl font-semibold tabular-nums tracking-tight", done && TONE_TEXT.good)}>{value}</span>
        <span className="text-sm text-zinc-400">/ {target}</span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div className={clsx("h-full rounded-full transition-all", done ? "bg-emerald-500" : pct >= 50 ? "bg-blue-500" : "bg-amber-500")}
          style={{ width: `${pct}%` }} />
      </div>
      {sub ? <div className="mt-1 text-xs text-zinc-500">{sub}</div> : null}
    </Card>
  );
  return href ? <Link href={href} className="block">{inner}</Link> : inner;
}

// ---------------------------------------------------------------------------
// Badges and pills
// ---------------------------------------------------------------------------

export type BadgeTone = "default" | "green" | "yellow" | "red" | "blue" | "violet";

export function Badge({ children, tone = "default", className }: {
  children: ReactNode; tone?: BadgeTone; className?: string;
}) {
  return (
    <span className={clsx(
      "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
      {
        "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300": tone === "default",
        "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300": tone === "green",
        "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300": tone === "yellow",
        "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300": tone === "red",
        "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300": tone === "blue",
        "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300": tone === "violet",
      },
      className,
    )}>
      {children}
    </span>
  );
}

export function healthTone(category?: string | null): "green" | "yellow" | "red" | "default" {
  if (category === "green") return "green";
  if (category === "yellow") return "yellow";
  if (category === "red") return "red";
  return "default";
}

/** Segmented control. Items are links (server pages with searchParams) or
 * buttons (client state) - pass `href` or `onClick` per item. */
export function Pills({ items, size = "sm" }: {
  items: { key: string; label: ReactNode; active: boolean; href?: string; onClick?: () => void; title?: string }[];
  size?: "sm" | "xs";
}) {
  const base = clsx(
    "whitespace-nowrap rounded-md font-medium transition",
    size === "sm" ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-[11px]",
  );
  const on = "bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900";
  const off = "text-zinc-600 hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-700/70";
  return (
    <div className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
      {items.map((it) => it.href ? (
        <Link key={it.key} href={it.href} title={it.title} className={clsx(base, it.active ? on : off)}>{it.label}</Link>
      ) : (
        <button key={it.key} type="button" onClick={it.onClick} title={it.title} className={clsx(base, it.active ? on : off)}>{it.label}</button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export type Column = string | { label: ReactNode; align?: "left" | "right" | "center"; width?: string; key?: string };

function col(c: Column) {
  return typeof c === "string" ? { label: c, align: "left" as const, width: undefined, key: c } : { align: "left" as const, ...c };
}

/** Heuristic: a header that reads like a number is right-aligned unless told
 * otherwise, so money and counts line up without every caller saying so. */
const NUMERIC = /^(\$|#|%|cases|calls|emails|texts|touches|count|total|mrr|revenue|amount|spend|leads|cac|ltv|payback|rate|days|avg|value|cost|paid|paying|firms|deals|demos|left|included|per|cpl|cpc|cpm|ctr|clicks|impressions|reach|\d)/i;

/** Data table. Numeric-looking headers right-align automatically; pass an
 * object column to override. `strongLast` bolds a totals row; `dense` for
 * long lists; `sticky` keeps the header visible inside a scrolling card. */
export function Table({ headers, rows, strongLast, dense, sticky, empty, rowClassName, maxHeight }: {
  headers: Column[];
  rows: ReactNode[][];
  strongLast?: boolean;
  dense?: boolean;
  sticky?: boolean;
  empty?: ReactNode;
  rowClassName?: (i: number) => string | undefined;
  maxHeight?: string;
}) {
  const cols = headers.map(col).map((c, i) => ({
    ...c,
    align: typeof headers[i] === "string" && i > 0 && NUMERIC.test(String(c.label ?? "")) ? "right" : c.align,
  }));
  const pad = dense ? "px-3 py-1.5" : "px-4 py-2";
  return (
    <div className={clsx("overflow-x-auto", maxHeight && "overflow-y-auto")} style={maxHeight ? { maxHeight } : undefined}>
      <table className="w-full text-sm">
        <thead className={clsx(sticky && "sticky top-0 z-10 bg-white dark:bg-zinc-900")}>
          <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
            {cols.map((c, i) => (
              <th key={c.key ?? i} style={c.width ? { width: c.width } : undefined}
                className={clsx(pad, "font-medium", {
                  "text-left": c.align === "left", "text-right": c.align === "right", "text-center": c.align === "center",
                })}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={cols.length}><Empty>{empty}</Empty></td></tr>
          ) : rows.map((cells, i) => (
            <tr key={i} className={clsx(
              "border-b border-zinc-100 last:border-0 dark:border-zinc-800/60",
              strongLast && i === rows.length - 1 && "bg-zinc-50 font-semibold dark:bg-zinc-800/40",
              rowClassName?.(i),
            )}>
              {cells.map((c, j) => (
                <td key={j} className={clsx(pad, "align-top", {
                  "text-left": cols[j]?.align === "left",
                  "text-right tabular-nums": cols[j]?.align === "right",
                  "text-center": cols[j]?.align === "center",
                })}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Primary value with a muted second line, for table cells. */
export function Cell({ children, sub, className }: { children: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <span className={clsx("block", className)}>
      <span>{children}</span>
      {sub ? <span className="block text-[11px] font-normal leading-tight text-zinc-400">{sub}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function Button({ className, variant = "primary", size = "md", ...props }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "md" | "sm" }) {
  return (
    <button
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        size === "md" ? "px-3 py-1.5 text-sm" : "px-2 py-1 text-xs",
        {
          "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white": variant === "primary",
          "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800": variant === "secondary",
          "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800": variant === "ghost",
          "bg-red-600 text-white hover:bg-red-500": variant === "danger",
        },
        className,
      )}
      {...props}
    />
  );
}

export const inputCls =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none transition focus:border-zinc-500 focus:ring-2 focus:ring-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400";

/** Compact select for card headers and filters. */
export const selectCls =
  "rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="font-medium text-zinc-600 dark:text-zinc-300">{label}</span>
      <div className="mt-1">{children}</div>
      {hint ? <span className="mt-0.5 block text-zinc-400">{hint}</span> : null}
    </label>
  );
}

/** Text link in the dashboard's accent colour. */
export function TextLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={clsx("text-blue-600 hover:underline dark:text-blue-400", className)}>{children}</Link>
  );
}
