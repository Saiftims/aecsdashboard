"use client";

import {
  Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
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
}: {
  data: { day: string; calls: number; emails: number; other: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="day" tick={{ fontSize: 11 }} />
        <YAxis allowDecimals={false} width={28} />
        <Tooltip />
        <Legend />
        <Bar dataKey="calls" stackId="a" fill="hsl(210 70% 50%)" name="Calls" radius={[0, 0, 0, 0]} />
        <Bar dataKey="emails" stackId="a" fill="hsl(160 60% 45%)" name="Emails" />
        <Bar dataKey="other" stackId="a" fill="hsl(45 90% 55%)" name="Meetings/other" radius={[4, 4, 0, 0]} />
      </BarChart>
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
