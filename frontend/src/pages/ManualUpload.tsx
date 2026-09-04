import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Upload } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { Input, Select } from "@/components/ui/Input";
import { PageHeader, Spinner } from "@/components/ui/Page";
import { api } from "@/lib/api";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted/70">{hint}</p>}
    </div>
  );
}

export function ManualUpload() {
  const [urlOrId, setUrlOrId] = useState("");
  const [channel, setChannel] = useState("");
  const [title, setTitle] = useState("");
  const [privacy, setPrivacy] = useState("private");
  const [tags, setTags] = useState("");

  const upload = useMutation({
    mutationFn: () =>
      api.manualUpload({
        url_or_id: urlOrId.trim(),
        channel: channel.trim() || undefined,
        title: title.trim() || undefined,
        privacy,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      setUrlOrId("");
      setTitle("");
      setTags("");
    },
  });

  return (
    <div>
      <PageHeader title="Manual upload" subtitle="Queue a VOD by URL or ID for download and upload" />

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardBody className="space-y-5">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                upload.mutate();
              }}
              className="space-y-5"
            >
              <Field
                label="VOD URL or ID"
                hint="Use twitch.tv/videos/123, a tracker stream URL, or a numeric ID."
              >
                <Input
                  required
                  autoFocus
                  placeholder="https://www.twitch.tv/videos/123456789"
                  value={urlOrId}
                  onChange={(e) => setUrlOrId(e.target.value)}
                />
              </Field>

              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Channel (optional)">
                  <Input
                    placeholder="inferred from the URL"
                    value={channel}
                    onChange={(e) => setChannel(e.target.value)}
                  />
                </Field>
                <Field label="Privacy">
                  <Select value={privacy} onChange={(e) => setPrivacy(e.target.value)} className="w-full">
                    <option value="private">Private</option>
                    <option value="unlisted">Unlisted</option>
                    <option value="public">Public</option>
                  </Select>
                </Field>
              </div>

              <Field label="Custom title (optional)">
                <Input
                  placeholder="generated automatically when empty"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={100}
                />
              </Field>

              <Field label="Tags (optional)" hint="Separate tags with commas.">
                <Input
                  placeholder="twitch, vod, gaming"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                />
              </Field>

              {upload.isError && (
                <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {(upload.error as Error).message}
                </p>
              )}
              {upload.isSuccess && (
                <p className="flex items-center gap-2 rounded-md border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok">
                  <CheckCircle2 size={16} /> Queued: {upload.data.vod_id}
                </p>
              )}

              <Button type="submit" disabled={upload.isPending || !urlOrId.trim()}>
                {upload.isPending ? <Spinner className="text-accent-fg" /> : <Upload size={16} />}
                Queue VOD
              </Button>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="space-y-3 text-sm text-muted">
            <h3 className="font-tight font-semibold text-fg">How it works</h3>
            <p>The worker downloads the queued VOD with twitch-dlp, then uploads it to YouTube using your selected privacy.</p>
            <p>Previously processed VODs are rejected to prevent duplicates.</p>
            <p>Track live progress from Overview or Queue.</p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
