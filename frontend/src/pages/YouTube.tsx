import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, KeyRound, RefreshCw, XCircle } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { CenterSpinner, PageHeader, Spinner } from "@/components/ui/Page";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/utils";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="text-sm text-muted">{label}</span>
      <span className="text-sm text-fg">{children}</span>
    </div>
  );
}

export function YouTube() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["yt-status"], queryFn: api.youtubeStatus });
  const [callback, setCallback] = useState("");

  const start = useMutation({
    mutationFn: api.youtubeStart,
    onSuccess: (res) => {
      if (data?.mode === "web") {
        window.location.href = res.authorization_url;
      } else {
        window.open(res.authorization_url, "_blank", "noopener");
      }
    },
  });

  const complete = useMutation({
    mutationFn: () => api.youtubeComplete(callback.trim()),
    onSuccess: () => {
      setCallback("");
      qc.invalidateQueries({ queryKey: ["yt-status"] });
    },
  });

  if (isLoading || !data) {
    return (
      <div>
        <PageHeader title="YouTube" subtitle="Estado de las credenciales OAuth" />
        <CenterSpinner />
      </div>
    );
  }

  const c = data.credentials;
  const healthy = c.valid;
  const HealthIcon = healthy ? CheckCircle2 : c.exists ? AlertTriangle : XCircle;
  const healthTone = healthy ? "text-ok" : c.exists ? "text-warn" : "text-danger";

  return (
    <div>
      <PageHeader title="YouTube" subtitle="Estado de las credenciales OAuth" />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Estado del token</CardTitle>
            <HealthIcon size={18} className={healthTone} />
          </CardHeader>
          <CardBody className="divide-y divide-line pt-1">
            <Row label="Credenciales">
              {c.exists ? (
                c.valid ? (
                  <Badge tone="ok">Válidas</Badge>
                ) : c.expired ? (
                  <Badge tone="warn">Expiradas</Badge>
                ) : (
                  <Badge tone="warn">Presentes</Badge>
                )
              ) : (
                <Badge tone="danger">Ausentes</Badge>
              )}
            </Row>
            <Row label="Refresh token">
              {c.has_refresh_token ? (
                <Badge tone="ok">Sí</Badge>
              ) : (
                <Badge tone="warn">No</Badge>
              )}
            </Row>
            <Row label="Expira">{c.expiry ? formatDate(c.expiry) : "—"}</Row>
            <Row label="Actualizado">{c.updated_at ? formatDate(c.updated_at) : "—"}</Row>
            <Row label="client_secret">
              <Badge tone={data.client_secret_exists ? "neutral" : "danger"}>
                {data.client_secret_exists ? data.client_secret_type : "ausente"}
              </Badge>
            </Row>
            {c.error && (
              <p className="pt-2 text-xs text-danger">{c.error}</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Renovar acceso</CardTitle>
            <KeyRound size={18} className="text-muted" />
          </CardHeader>
          <CardBody className="space-y-4">
            {!data.ready ? (
              <p className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
                Falta un <code className="font-mono">client_secret.json</code> válido (web o desktop)
                en el servidor.
              </p>
            ) : (
              <>
                <p className="text-sm text-muted">
                  Modo <Badge tone="neutral">{data.mode}</Badge>. Inicia el flujo OAuth de Google
                  para generar un token nuevo.
                </p>
                <Button onClick={() => start.mutate()} disabled={start.isPending}>
                  {start.isPending ? <Spinner className="text-accent-fg" /> : <RefreshCw size={16} />}
                  {data.mode === "web" ? "Conectar con YouTube" : "Iniciar renovación"}
                </Button>

                {data.mode === "installed" && (
                  <div className="space-y-2 border-t border-line pt-4">
                    <label className="text-xs font-medium text-muted">
                      Pega la URL completa a la que te redirigió Google
                    </label>
                    <Input
                      placeholder="http://localhost:53682/?state=…&code=…"
                      value={callback}
                      onChange={(e) => setCallback(e.target.value)}
                    />
                    {complete.isError && (
                      <p className="text-sm text-danger">{(complete.error as Error).message}</p>
                    )}
                    {complete.isSuccess && (
                      <p className="flex items-center gap-2 text-sm text-ok">
                        <CheckCircle2 size={15} /> Token renovado.
                      </p>
                    )}
                    <Button
                      variant="secondary"
                      onClick={() => complete.mutate()}
                      disabled={complete.isPending || !callback.trim()}
                    >
                      {complete.isPending ? <Spinner /> : "Completar renovación"}
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
