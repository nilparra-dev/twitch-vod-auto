import { cn } from "@/lib/utils";

type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";

const tones: Record<Tone, string> = {
  neutral: "bg-elevated text-muted border-line",
  accent: "bg-accent-soft text-accent border-transparent",
  ok: "bg-ok/12 text-ok border-transparent",
  warn: "bg-warn/12 text-warn border-transparent",
  danger: "bg-danger/12 text-danger border-transparent",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  uploaded: "ok",
  completed: "ok",
  failed: "danger",
  pending: "neutral",
  queued: "neutral",
  downloading: "accent",
  downloaded: "accent",
  encoding: "accent",
  uploading: "accent",
};

const STATUS_LABEL: Record<string, string> = {
  uploaded: "Subido",
  completed: "Completado",
  failed: "Fallido",
  pending: "Pendiente",
  queued: "En cola",
  downloading: "Descargando",
  downloaded: "Descargado",
  encoding: "Procesando",
  uploading: "Subiendo",
};

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "neutral";
  const active = tone === "accent";
  return (
    <Badge tone={tone}>
      {active && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}
