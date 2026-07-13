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
  data: { day: string; calls: number; emails: number; other: number }[];
  callsTarget?: number;
  emailsTarget?: number;
}) {
  const maxVal = Math.max(
    callsTarget ?? 0,
    emailsTarget ?? 0,
    ...data.map((d) => Math.max(d.calls, d.emails)),
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
