import { useMutation } from "@tanstack/react-query";
import { ListVideo, Trash2 } from "lucide-react";

import { StatusBadge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState, PageHeader } from "@/components/ui/Page";
import { useLiveState } from "@/hooks/useLiveState";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/utils";

export function Queue() {
  const { state } = useLiveState();
  const queue = state?.queue ?? [];
  const remove = useMutation({ mutationFn: api.deleteQueue });

  return (
    <div>
      <PageHeader title="Queue" subtitle={`${queue.length} items`} />

      <Card className="overflow-hidden">
        {queue.length === 0 ? (
          <EmptyState icon={<ListVideo size={28} />} title="Queue is empty" hint="No downloads are waiting." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-5 py-3 font-medium">Channel</th>
                  <th className="px-5 py-3 font-medium">Video ID</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="hidden px-5 py-3 font-medium sm:table-cell">Attempts</th>
                  <th className="hidden px-5 py-3 font-medium lg:table-cell">Queued</th>
                  <th className="px-5 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {queue.map((q) => (
                  <tr key={q.id} className="transition-colors hover:bg-elevated/50">
                    <td className="px-5 py-3 font-medium text-fg">{q.channel}</td>
                    <td className="px-5 py-3 font-mono text-xs text-muted">{q.video_id}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={q.status} />
                      {q.error && (
                        <p className="mt-1 max-w-xs truncate text-xs text-danger" title={q.error}>
                          {q.error}
                        </p>
                      )}
                    </td>
                    <td className="hidden px-5 py-3 text-muted sm:table-cell">{q.attempts}</td>
                    <td className="hidden px-5 py-3 text-muted lg:table-cell">
                      {formatRelative(q.created_at)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <button
                        onClick={() => {
                          if (confirm(`Remove ${q.video_id} from the queue?`)) remove.mutate(q.vod_id);
                        }}
                        className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-danger/10 hover:text-danger"
                        title="Remove from queue"
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
