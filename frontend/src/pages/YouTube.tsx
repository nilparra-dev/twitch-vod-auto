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
        <PageHeader title="YouTube" subtitle="OAuth credential status" />
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
      <PageHeader title="YouTube" subtitle="OAuth credential status" />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Token status</CardTitle>
            <HealthIcon size={18} className={healthTone} />
          </CardHeader>
          <CardBody className="divide-y divide-line pt-1">
            <Row label="Credentials">
              {c.exists ? (
                c.valid ? (
                  <Badge tone="ok">Valid</Badge>
                ) : c.expired ? (
                  <Badge tone="warn">Expired</Badge>
                ) : (
                  <Badge tone="warn">Present</Badge>
                )
              ) : (
                <Badge tone="danger">Missing</Badge>
              )}
            </Row>
            <Row label="Refresh token">
              {c.has_refresh_token ? (
                <Badge tone="ok">Yes</Badge>
              ) : (
                <Badge tone="warn">No</Badge>
              )}
            </Row>
            <Row label="Expires">{c.expiry ? formatDate(c.expiry) : "-"}</Row>
            <Row label="Updated">{c.updated_at ? formatDate(c.updated_at) : "-"}</Row>
            <Row label="client_secret">
              <Badge tone={data.client_secret_exists ? "neutral" : "danger"}>
                {data.client_secret_exists ? data.client_secret_type : "missing"}
              </Badge>
            </Row>
            {c.error && (
              <p className="pt-2 text-xs text-danger">{c.error}</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Renew access</CardTitle>
            <KeyRound size={18} className="text-muted" />
          </CardHeader>
          <CardBody className="space-y-4">
            {!data.ready ? (
              <p className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
                A valid web or desktop <code className="font-mono">client_secret.json</code> is missing.
              </p>
            ) : (
              <>
                <p className="text-sm text-muted">
                  Mode: <Badge tone="neutral">{data.mode}</Badge>. Start Google's OAuth flow to create a new token.
                </p>
                <Button onClick={() => start.mutate()} disabled={start.isPending}>
                  {start.isPending ? <Spinner className="text-accent-fg" /> : <RefreshCw size={16} />}
                  {data.mode === "web" ? "Connect YouTube" : "Start renewal"}
                </Button>

                {data.mode === "installed" && (
                  <div className="space-y-2 border-t border-line pt-4">
                    <label className="text-xs font-medium text-muted">
                      Paste the full URL Google redirected you to
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
                        <CheckCircle2 size={15} /> Token renewed.
                      </p>
                    )}
                    <Button
                      variant="secondary"
                      onClick={() => complete.mutate()}
                      disabled={complete.isPending || !callback.trim()}
                    >
                      {complete.isPending ? <Spinner /> : "Complete renewal"}
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
