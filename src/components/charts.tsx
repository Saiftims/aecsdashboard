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

export function DailyActivityChart({
  data,
  callsTarget,
  emailsTarget,
}: {
  data: { day: string; calls: number; emails: number; sms?: number; social?: number }[];
  callsTarget?: number;
  emailsTarget?: number;
}) {
  // Only draw the texting and social bars once there is something in them, so a
  // team that does not use those channels keeps a two-bar chart.
  const hasSms = data.some((d) => (d.sms ?? 0) > 0);
  const hasSocial = data.some((d) => (d.social ?? 0) > 0);
  const maxVal = Math.max(
    callsTarget ?? 0,
    emailsTarget ?? 0,
    ...data.map((d) => Math.max(d.calls, d.emails, d.sms ?? 0, d.social ?? 0)),
  );
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 48 }} barGap={2}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="day" tick={{ fontSize: 11 }} />
        <YAxis allowDecimals={false} width={28} domain={[0, Math.ceil(maxVal * 1.1)]} />
        <Tooltip />
        <Legend />
        <Bar dataKey="calls" fill="hsl(210 70% 50%)" name="Calls" radius={[3, 3, 0, 0]} />
        <Bar dataKey="emails" fill="hsl(160 60% 45%)" name="Emails" radius={[3, 3, 0, 0]} />
        {hasSms ? (
          <Bar dataKey="sms" fill="hsl(38 92% 50%)" name="Texts" radius={[3, 3, 0, 0]} />
        ) : null}
        {hasSocial ? (
          <Bar dataKey="social" fill="hsl(280 55% 58%)" name="Other channels"
            radius={[3, 3, 0, 0]} />
        ) : null}
        {callsTarget ? (
          <ReferenceLine
            y={callsTarget}
            stroke="hsl(210 70% 50%)"
            strokeDasharray="5 4"
            label={{ value: `Calls target ${callsTarget}`, position: "right", fontSize: 10, fill: "hsl(210 70% 45%)" }}
          />
        ) : null}
        {emailsTarget ? (
          <ReferenceLine
            y={emailsTarget}
            stroke="hsl(160 60% 40%)"
            strokeDasharray="5 4"
            label={{ value: `Emails target ${emailsTarget}`, position: "right", fontSize: 10, fill: "hsl(160 60% 35%)" }}
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
