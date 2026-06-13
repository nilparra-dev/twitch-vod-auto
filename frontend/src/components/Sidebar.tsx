import {
  Film,
  LayoutDashboard,
  ListVideo,
  LogOut,
  ScrollText,
  Upload,
  Youtube,
} from "lucide-react";
import { NavLink } from "react-router-dom";

import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useLogout, useMe } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";
import { useEvents } from "@/store/events";

const NAV = [
  { to: "/", label: "Resumen", icon: LayoutDashboard, end: true },
  { to: "/vods", label: "VODs", icon: Film },
  { to: "/queue", label: "Cola", icon: ListVideo },
  { to: "/upload", label: "Subida manual", icon: Upload },
  { to: "/youtube", label: "YouTube", icon: Youtube },
  { to: "/logs", label: "Logs", icon: ScrollText },
];

function ConnDot() {
  const conn = useEvents((s) => s.conn);
  const map = {
    open: { c: "bg-ok", t: "En vivo" },
    connecting: { c: "bg-warn animate-pulse", t: "Conectando…" },
    closed: { c: "bg-muted", t: "Sin conexión" },
  } as const;
  const { c, t } = map[conn];
  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <span className={cn("h-2 w-2 rounded-full", c)} />
      {t}
    </div>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { data: me } = useMe();
  const logout = useLogout();
  const queued = useEvents((s) => s.state?.queue_summary.queued ?? 0);

  return (
    <aside className="flex h-full w-[240px] flex-col border-r border-line bg-surface/60 px-3.5 py-5 backdrop-blur">
      <div className="px-2">
        <Logo />
      </div>

      <nav className="mt-7 flex flex-1 flex-col gap-1">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent-soft text-accent"
                  : "text-muted hover:bg-elevated hover:text-fg",
              )
            }
          >
            <Icon size={17} className="shrink-0" />
            <span className="flex-1">{label}</span>
            {to === "/queue" && queued > 0 && (
              <span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-fg">
                {queued}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-4 space-y-3 border-t border-line pt-4">
        <ConnDot />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5 overflow-hidden">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-fg">
              {(me?.user ?? "?").charAt(0).toUpperCase()}
            </div>
            <span className="truncate text-sm text-fg">{me?.user ?? "—"}</span>
          </div>
          <div className="flex items-center">
            <ThemeToggle />
            <button
              onClick={() => logout.mutate()}
              className="flex h-9 w-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-danger"
              aria-label="Cerrar sesión"
              title="Cerrar sesión"
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
