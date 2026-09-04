import { useQuery } from "@tanstack/react-query";
import { Pause, Play, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Select } from "@/components/ui/Input";
import { CenterSpinner, PageHeader } from "@/components/ui/Page";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

function lineTone(line: string): string {
  if (/\bERROR\b|\bCRITICAL\b/.test(line)) return "text-danger";
  if (/\bWARN(ING)?\b/.test(line)) return "text-warn";
  if (/\bOK\b|completed|upload OK/i.test(line)) return "text-ok";
  return "text-muted";
}

export function Logs() {
  const [lines, setLines] = useState(200);
  const [live, setLive] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["logs", lines],
    queryFn: () => api.logs(lines),
    refetchInterval: live ? 4000 : false,
  });

  const log = useMemo(() => data?.logs ?? [], [data]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && live) el.scrollTop = el.scrollHeight;
  }, [log, live]);

  return (
    <div>
      <PageHeader
        title="Logs"
        subtitle="Pipeline output"
        action={
          <div className="flex items-center gap-2">
            <Select value={lines} onChange={(e) => setLines(Number(e.target.value))}>
              {[100, 200, 500, 1000].map((n) => (
                <option key={n} value={n}>
                  {n} lines
                </option>
              ))}
            </Select>
            <Button variant="secondary" size="icon" onClick={() => setLive((v) => !v)} title={live ? "Pause" : "Resume"}>
              {live ? <Pause size={16} /> : <Play size={16} />}
            </Button>
            <Button variant="secondary" size="icon" onClick={() => refetch()} title="Refresh">
              <RefreshCw size={16} className={cn(isFetching && "animate-spin")} />
            </Button>
          </div>
        }
      />

      <Card className="overflow-hidden">
        {isLoading ? (
          <CenterSpinner />
        ) : (
          <div ref={boxRef} className="max-h-[70vh] overflow-auto bg-bg/40 p-4">
            <pre className="font-mono text-xs leading-relaxed">
              {log.length === 0 ? (
                <span className="text-muted">No logs yet.</span>
              ) : (
                log.map((l, i) => (
                  <div key={i} className={cn("whitespace-pre-wrap break-all", lineTone(l))}>
                    {l}
                  </div>
                ))
              )}
            </pre>
          </div>
        )}
      </Card>
    </div>
  );
}
