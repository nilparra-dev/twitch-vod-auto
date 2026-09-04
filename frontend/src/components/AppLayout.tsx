import { CheckCircle2, Menu, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";

import { Logo } from "@/components/Logo";
import { Sidebar } from "@/components/Sidebar";
import { useLiveState } from "@/hooks/useLiveState";
import { cn } from "@/lib/utils";

function useOAuthToast() {
  const [toast, setToast] = useState<"success" | "error" | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("youtube_oauth");
    if (result === "success" || result === "error") {
      setToast(result);
      window.history.replaceState({}, "", window.location.pathname);
      const t = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(t);
    }
  }, []);
  return toast;
}

export function AppLayout() {
  // Keep the SSE connection alive for the entire app.
  useLiveState();
  const oauthToast = useOAuthToast();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Desktop sidebar */}
      <div className="hidden md:block">
        <Sidebar />
      </div>

      {/* Mobile sidebar drawer */}
      <div
        className={cn(
          "fixed inset-0 z-40 md:hidden",
          open ? "pointer-events-auto" : "pointer-events-none",
        )}
      >
        <div
          className={cn(
            "absolute inset-0 bg-black/50 transition-opacity",
            open ? "opacity-100" : "opacity-0",
          )}
          onClick={() => setOpen(false)}
        />
        <div
          className={cn(
            "absolute left-0 top-0 h-full transition-transform duration-200",
            open ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <Sidebar onNavigate={() => setOpen(false)} />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex h-14 items-center justify-between border-b border-line px-4 md:hidden">
          <Logo />
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-elevated"
            aria-label="Menu"
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-5 py-7 md:px-8 md:py-9">
            <Outlet />
          </div>
        </main>
      </div>

      {oauthToast && (
        <div
          className={cn(
            "fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-md border px-4 py-3 text-sm shadow-pop animate-fade-up",
            oauthToast === "success"
              ? "border-ok/30 bg-ok/10 text-ok"
              : "border-danger/30 bg-danger/10 text-danger",
          )}
        >
          {oauthToast === "success" ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
          {oauthToast === "success"
            ? "YouTube token renewed."
            : "Could not renew the YouTube token."}
        </div>
      )}
    </div>
  );
}
