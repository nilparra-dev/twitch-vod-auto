import { Activity, CheckCircle2, Film, XCircle } from "lucide-react";
import { Link } from "react-router-dom";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { StatusBadge } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState, PageHeader } from "@/components/ui/Page";
import { useLiveState } from "@/hooks/useLiveState";
import { useTheme } from "@/providers/ThemeProvider";
import type { ActivityDay, Progress } from "@/lib/api";
import { formatBytes } from "@/lib/utils";

function StatCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
        <span className="text-muted">{icon}</span>
      </div>
      <div className={`mt-3 font-display text-4xl font-semibold tabular-nums ${tone ?? "text-fg"}`}>
        {value.toLocaleString()}
      </div>
    </Card>
  );
}

function ActivityChart({ data }: { data: ActivityDay[] }) {
  const { theme } = useTheme();
  const accent = theme === "dark" ? "#D08763" : "#C2724E";
  const line = theme === "dark" ? "rgba(255,255,255,.08)" : "#E6E2D8";
  const muted = theme === "dark" ? "#A8A59C" : "#6B6862";

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="up" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity={0.35} />
            <stop offset="100%" stopColor={accent} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={line} vertical={false} />
        <XAxis
          dataKey="day"
          tickFormatter={(d: string) => d.slice(5)}
          tick={{ fill: muted, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fill: muted, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={36}
        />
        <Tooltip
          contentStyle={{
            background: "var(--elevated)",
            border: "1px solid var(--line)",
            borderRadius: 10,
            fontSize: 12,
            color: "var(--fg)",
          }}
          labelStyle={{ color: "var(--muted)" }}
        />
        <Area
          type="monotone"
          dataKey="uploaded"
          name="Subidos"
          stroke={accent}
          strokeWidth={2}
          fill="url(#up)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function ProgressRow({ p }: { p: Progress }) {
  const pct = Math.min(100, Math.max(0, p.percent || 0));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="truncate font-mono text-xs text-fg">
          {p.channel || "—"} · {p.video_id}
        </span>
        <span className="shrink-0 text-xs text-muted">
          {p.stage ?? p.status} · {pct.toFixed(0)}%
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-elevated">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between text-[11px] text-muted">
        <span>{p.message}</span>
        <span>{[p.speed, p.eta].filter(Boolean).join(" · ")}</span>
      </div>
    </div>
  );
}

export function Overview() {
  const { state } = useLiveState();
  const s = state?.summary;
  const active = Object.values(state?.active_downloads ?? {});
  const recent = state?.recent_vods ?? [];

  return (
    <div>
      <PageHeader title="Resumen" subtitle="Estado del pipeline en tiempo real" />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={<Film size={18} />} label="Total" value={s?.total ?? 0} />
        <StatCard
          icon={<CheckCircle2 size={18} />}
          label="Subidos"
          value={s?.uploaded ?? 0}
          tone="text-ok"
        />
        <StatCard
          icon={<Activity size={18} />}
          label="En cola"
          value={state?.queue_summary.queued ?? 0}
          tone="text-accent"
        />
        <StatCard
          icon={<XCircle size={18} />}
          label="Fallos"
          value={s?.failed ?? 0}
          tone="text-danger"
        />
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Actividad (14 días)</CardTitle>
          </CardHeader>
          <CardBody className="pt-2">
            {state ? (
              <ActivityChart data={state.activity} />
            ) : (
              <div className="skeleton h-[220px]" />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Descargas activas</CardTitle>
            {active.length > 0 && <span className="text-xs text-accent">{active.length}</span>}
          </CardHeader>
          <CardBody className="space-y-5">
            {active.length === 0 ? (
              <EmptyState title="Nada en curso" hint="Las descargas y subidas activas aparecerán aquí." />
            ) : (
              active.map((p) => <ProgressRow key={p.vod_id} p={p} />)
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>VODs recientes</CardTitle>
          <Link to="/vods" className="text-xs text-accent hover:underline">
            Ver todos
          </Link>
        </CardHeader>
        <CardBody className="pt-2">
          {recent.length === 0 ? (
            <EmptyState title="Sin VODs todavía" />
          ) : (
            <div className="divide-y divide-line">
              {recent.map((v) => (
                <div key={v.vod_id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">{v.channel}</p>
                    <p className="truncate font-mono text-xs text-muted">{v.video_id}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="hidden text-xs text-muted sm:block">
                      {formatBytes(v.file_size_mb)}
                    </span>
                    <StatusBadge status={v.status} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
