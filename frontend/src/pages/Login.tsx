import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { LogoMark } from "@/components/Logo";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Page";
import { useLogin, useMe } from "@/hooks/useAuth";

export function Login() {
  const { data: me, isLoading } = useMe();
  const login = useLogin();
  const navigate = useNavigate();
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");

  if (!isLoading && me) return <Navigate to="/" replace />;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    login.mutate({ user, password }, { onSuccess: () => navigate("/", { replace: true }) });
  };

  return (
    <div className="grid min-h-dvh place-items-center px-5">
      <div className="w-full max-w-sm animate-fade-up">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <LogoMark size={52} />
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-fg">VOD Auto</h1>
            <p className="mt-1 text-sm text-muted">Administration dashboard</p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="card space-y-4 p-6">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted" htmlFor="user">
              Username
            </label>
            <Input
              id="user"
              autoFocus
              autoComplete="username"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted" htmlFor="password">
              Password
            </label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {login.isError && (
            <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              {(login.error as Error).message}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={login.isPending}>
            {login.isPending ? <Spinner className="text-accent-fg" /> : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
