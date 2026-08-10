"use client";

import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

export function FunnelChart({ data }: { data: { label: string; count: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} layout="vertical" margin={{ left: 40, right: 24 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" allowDecimals={false} />
        <YAxis type="category" dataKey="label" width={140} tick={{ fontSize: 12 }} />
        <Tooltip />
        <Bar dataKey="count" radius={[0, 6, 6, 0]}>
          {data.map((_, i) => (
            <Cell key={i} fill={`hsl(${210 - i * 12} 70% ${45 + i * 3}%)`} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** One stacked bar per day - every channel a rep can touch a lead through -
 * measured against a single total-activity target. Channel-level targets would
 * punish a rep who hit the number a different way. */
export function DailyActivityChart({
  data,
  activityTarget,
}: {
  data: {
    day: string; calls: number; emails: number;
    sms?: number; other?: number; total?: number;
  }[];
  activityTarget?: number;
}) {
  const height = (d: (typeof data)[number]) =>
    d.total ?? d.calls + d.emails + (d.sms ?? 0) + (d.other ?? 0);
  // Keep the target line in frame even on a quiet week, and leave headroom
  // above the tallest stack so its label is readable.
  const maxVal = Math.max(activityTarget ?? 0, ...data.map(height), 1);
  const SERIES = [
    { key: "calls", name: "Calls", fill: "hsl(210 70% 50%)", always: true,
      get: (d: (typeof data)[number]) => d.calls },
    { key: "emails", name: "Emails", fill: "hsl(160 60% 45%)", always: true,
      get: (d: (typeof data)[number]) => d.emails },
    { key: "sms", name: "Texts", fill: "hsl(38 92% 50%)", always: false,
      get: (d: (typeof data)[number]) => d.sms },
    // DMs, meetings, demos and visits together. Split out, each was a sliver
    // too thin to read on the stack.
    { key: "other", name: "Other channels", fill: "hsl(280 55% 58%)", always: false,
      get: (d: (typeof data)[number]) => d.other },
  ];
  // Hide a channel nobody used, so a team that only calls and emails still
  // reads as a two-colour chart. The topmost drawn bar gets the rounded cap.
  const shown = SERIES.filter(
    (s) => s.always || data.some((d) => (s.get(d) ?? 0) > 0));
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 56 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="day" tick={{ fontSize: 11 }} />
        <YAxis allowDecimals={false} width={28} domain={[0, Math.ceil(maxVal * 1.15)]} />
        <Tooltip />
        <Legend />
        {shown.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            stackId="activity"
            fill={s.fill}
            name={s.name}
            radius={i === shown.length - 1 ? [3, 3, 0, 0] : undefined}
          />
        ))}
        {activityTarget ? (
          <ReferenceLine
            y={activityTarget}
            stroke="hsl(220 9% 40%)"
            strokeDasharray="5 4"
            label={{
              value: `Target ${activityTarget}/day`,
              position: "right", fontSize: 10, fill: "hsl(220 9% 40%)",
            }}
          />
        ) : null}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Cohort retention curves: x = months since first case, y = % retained,
 * one line per first-case cohort. */
export function RetentionChart({
  cohorts,
  monthCols,
}: {
  cohorts: { label: string; retention: (number | null)[] }[];
  monthCols: number;
}) {
  const data = Array.from({ length: monthCols }, (_, m) => {
    const row: Record<string, number | string | null> = { month: `Month ${m}` };
    for (const c of cohorts) row[c.label] = c.retention[m] ?? null;
    return row;
  });
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 24, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
        <YAxis width={40} domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v) => (v === null ? "-" : `${v}%`)} />
        <Legend />
        {cohorts.map((c, i) => (
          <Line
            key={c.label}
            type="monotone"
            dataKey={c.label}
            stroke={`hsl(${210 - i * 40} 70% 50%)`}
            strokeWidth={2}
            connectNulls
            dot={{ r: 3 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Dollar retention by cohort: x = months since a cohort's first revenue,
 * y = % of that cohort's month-0 dollars. Unlike logo retention this can exceed
 * 100% when firms expand, so the axis is not clamped. */
export function RevenueRetentionChart({
  cohorts,
  monthCols,
}: {
  cohorts: { label: string; retention: (number | null)[] }[];
  monthCols: number;
}) {
  const data = Array.from({ length: monthCols }, (_, m) => {
    const row: Record<string, number | string | null> = { month: `Month ${m}` };
    for (const c of cohorts) row[c.label] = c.retention[m] ?? null;
    return row;
  });
  const peak = Math.max(100, ...cohorts.flatMap((c) => c.retention.map((v) => v ?? 0)));
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 24, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
        <YAxis width={44} domain={[0, Math.ceil((peak * 1.1) / 10) * 10]}
               tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v) => (v === null ? "-" : `${v}% of month 0`)} />
        <Legend />
        <ReferenceLine y={100} stroke="hsl(0 0% 60%)" strokeDasharray="5 4" />
        {cohorts.map((c, i) => (
          <Line
            key={c.label}
            type="monotone"
            dataKey={c.label}
            stroke={`hsl(${210 - i * 40} 70% 50%)`}
            strokeWidth={2}
            connectNulls
            dot={{ r: 3 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Subscription vs transactional retention. Each point is the mean of every
 * eligible firm's own (month N / month 0), so firm size cancels out and the
 * two billing models are compared on shape, not volume. */
export function BillingRetentionChart({
  curves,
  monthCols,
}: {
  curves: { label: string; points: { month: number; pct: number | null }[] }[];
  monthCols: number;
}) {
  const data = Array.from({ length: monthCols }, (_, m) => {
    const row: Record<string, number | string | null> = { month: `Month ${m}` };
    for (const c of curves) row[c.label] = c.points[m]?.pct ?? null;
    return row;
  });
  const peak = Math.max(100, ...curves.flatMap((c) => c.points.map((p) => p.pct ?? 0)));
  const color: Record<string, string> = {
    Subscription: "hsl(160 60% 40%)",
    Transactional: "hsl(210 70% 50%)",
  };
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 24, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
        <YAxis width={44} domain={[0, Math.ceil((peak * 1.1) / 10) * 10]}
               tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v) => (v === null ? "-" : `${v}% of month 0`)} />
        <Legend />
        <ReferenceLine y={100} stroke="hsl(0 0% 60%)" strokeDasharray="5 4"
                       label={{ value: "held", position: "right", fontSize: 10, fill: "hsl(0 0% 45%)" }} />
        {curves.map((c) => (
          <Line
            key={c.label}
            type="monotone"
            dataKey={c.label}
            stroke={color[c.label] ?? "hsl(280 60% 50%)"}
            strokeWidth={2.5}
            connectNulls
            dot={{ r: 4 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function MonthlyBarChart({
  data,
}: {
  data: { month: string; count: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
        <YAxis allowDecimals={false} width={28} />
        <Tooltip />
        <Bar dataKey="count" fill="hsl(210 70% 50%)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
