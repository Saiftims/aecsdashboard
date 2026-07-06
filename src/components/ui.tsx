/** Small shadcn-style UI kit (Tailwind). */
import { clsx } from "clsx";
import Link from "next/link";
import type { HTMLAttributes, ReactNode } from "react";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx(
        "rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
      <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{title}</h3>
      {action}
    </div>
  );
}

export function Stat({
  label, value, sub, tone, href,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "good" | "warn" | "bad";
  href?: string;
}) {
  const inner = (
    <Card
      className={clsx("px-4 py-3", href && "transition hover:border-zinc-400 hover:shadow-md dark:hover:border-zinc-600")}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div
        className={clsx("mt-1 text-2xl font-bold", {
          "text-emerald-600": tone === "good",
          "text-amber-600": tone === "warn",
          "text-red-600": tone === "bad",
        })}
      >
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-xs text-zinc-500">{sub}</div> : null}
    </Card>
  );
  return href ? <Link href={href} className="block">{inner}</Link> : inner;
}

export function Badge({
  children, tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "green" | "yellow" | "red" | "blue";
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        {
          "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300": tone === "default",
          "bg-emerald-100 text-emerald-800": tone === "green",
          "bg-amber-100 text-amber-800": tone === "yellow",
          "bg-red-100 text-red-800": tone === "red",
          "bg-blue-100 text-blue-800": tone === "blue",
        },
      )}
    >
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

export function Table({
  headers, rows,
}: {
  headers: string[];
  rows: ReactNode[][];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
            {headers.map((h) => (
              <th key={h} className="px-4 py-2 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={headers.length} className="px-4 py-6 text-center text-zinc-400">
                Nothing here
              </td>
            </tr>
          ) : (
            rows.map((cells, i) => (
              <tr key={i} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                {cells.map((c, j) => (
                  <td key={j} className="px-4 py-2">{c}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Button({
  className, variant = "primary", ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
}) {
  return (
    <button
      className={clsx(
        "inline-flex items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        {
          "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900": variant === "primary",
          "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200": variant === "secondary",
          "bg-red-600 text-white hover:bg-red-500": variant === "danger",
        },
        className,
      )}
      {...props}
    />
  );
}

export const inputCls =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
