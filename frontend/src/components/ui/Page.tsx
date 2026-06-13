import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-7 flex items-end justify-between gap-4 animate-fade-up">
      <div>
        <h1 className="font-display text-[28px] font-semibold leading-tight tracking-tight text-fg">
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("animate-spin text-muted", className)} size={18} />;
}

export function CenterSpinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <Spinner className="h-6 w-6" />
    </div>
  );
}

export function EmptyState({ icon, title, hint }: { icon?: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      {icon && <div className="mb-1 text-muted">{icon}</div>}
      <p className="font-tight text-sm font-medium text-fg">{title}</p>
      {hint && <p className="max-w-sm text-sm text-muted">{hint}</p>}
    </div>
  );
}
