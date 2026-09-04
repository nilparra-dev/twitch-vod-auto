import { useMutation } from "@tanstack/react-query";
import { Check, Clipboard, ExternalLink, Play } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { PageHeader, Spinner } from "@/components/ui/Page";
import { api } from "@/lib/api";

export function WatchVod() {
  const [value, setValue] = useState("");
  const [copied, setCopied] = useState("");
  const resolve = useMutation({ mutationFn: () => api.resolveM3U8(value.trim()) });

  async function copy(url: string) {
    await navigator.clipboard.writeText(url);
    setCopied(url);
    window.setTimeout(() => setCopied(""), 1800);
  }

  return (
    <div>
      <PageHeader title="Watch VOD" subtitle="Get a playable M3U8 URL without downloading the video" />
      <div className="space-y-5">
        <Card>
          <CardBody>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                resolve.mutate();
              }}
            >
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted">VOD URL, ID, or target</label>
                <Input
                  autoFocus
                  required
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder="Twitch, TwitchTracker, Streams Charts, SullyGnome, or video:channel_id_timestamp"
                />
                <p className="text-xs text-muted/70">
                  For a hidden stream, use its tracker URL or video:channel_streamId_timestamp.
                </p>
              </div>
              {resolve.isError && (
                <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {resolve.error instanceof Error ? resolve.error.message : "Could not resolve this VOD"}
                </p>
              )}
              <Button type="submit" disabled={resolve.isPending || !value.trim()}>
                {resolve.isPending ? <Spinner className="text-accent-fg" /> : <Play size={16} />}
                Find M3U8
              </Button>
            </form>
          </CardBody>
        </Card>

        {resolve.data && (
          <Card>
            <CardBody className="space-y-5">
              <div>
                <h2 className="font-tight text-lg font-semibold text-fg">Available playlists</h2>
                <p className="mt-1 text-sm text-muted">
                  {resolve.data.channel ? `${resolve.data.channel} · ` : ""}
                  {resolve.data.kind === "hidden" ? "Hidden VOD" : `VOD ${resolve.data.video_id}`}
                  {resolve.data.started_at ? ` · ${new Date(resolve.data.started_at).toLocaleString()}` : ""}
                </p>
                {resolve.data.canonical_target && (
                  <code className="mt-2 block break-all rounded-md bg-elevated px-3 py-2 text-xs text-muted">
                    {resolve.data.canonical_target}
                  </code>
                )}
              </div>

              <div className="divide-y divide-line overflow-hidden rounded-md border border-line">
                {resolve.data.formats.map((format) => (
                  <div key={format.url} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-fg">{format.id}</p>
                      <p className="truncate text-xs text-muted" title={format.url}>
                        {format.url}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button type="button" size="sm" variant="secondary" onClick={() => copy(format.url)}>
                        {copied === format.url ? <Check size={15} /> : <Clipboard size={15} />}
                        {copied === format.url ? "Copied" : "Copy"}
                      </Button>
                      <a
                        href={format.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-line bg-surface px-3 text-sm font-medium text-fg transition-colors hover:bg-elevated"
                      >
                        <ExternalLink size={15} /> Open
                      </a>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted">
                If your browser cannot play the URL, copy it into VLC under Media → Open Network Stream.
              </p>
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}
