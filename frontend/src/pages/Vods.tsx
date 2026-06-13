import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ExternalLink, RotateCcw, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Select } from "@/components/ui/Input";
import { CenterSpinner, EmptyState, PageHeader } from "@/components/ui/Page";
import { api } from "@/lib/api";
import { formatBytes, formatRelative } from "@/lib/utils";
import { useEvents } from "@/store/events";

const STATUSES = ["", "pending", "downloading", "uploaded", "failed"];
const STATUS_LABEL: Record<string, string> = {
  "": "Todos los estados",
  pending: "Pendiente",
  downloading: "En proceso",
  uploaded: "Subido",
  failed: "Fallido",
};
const PAGE = 25;

export function Vods() {
  const qc = useQueryClient();
  const channels = useEvents((s) => s.state?.channels ?? []);

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("");
  const [channel, setChannel] = useState("");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => setOffset(0), [debounced, status, channel]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["vods", { debounced, status, channel, offset }],
    queryFn: () =>
      api.vods({ search: debounced, status, channel, limit: PAGE, offset }),
    placeholderData: keepPreviousData,
  });

  const retry = useMutation({
    mutationFn: api.retryVod,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vods"] }),
  });
  const remove = useMutation({
    mutationFn: api.deleteVod,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vods"] }),
  });

  const vods = data?.vods ?? [];
  const total = data?.total ?? 0;
  const page = Math.floor(offset / PAGE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div>
      <PageHeader title="VODs" subtitle={`${total.toLocaleString()} en total`} />

      <Card className="mb-4 flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input
            className="pl-9"
            placeholder="Buscar por canal, video ID o VOD ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">Todos los canales</option>
          {channels.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </Card>

      <Card className="overflow-hidden">
        {isLoading ? (
          <CenterSpinner />
        ) : isError ? (
          <EmptyState title="Error cargando VODs" hint={(error as Error).message} />
        ) : vods.length === 0 ? (
          <EmptyState title="Sin resultados" hint="Prueba a cambiar los filtros." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-5 py-3 font-medium">Canal</th>
                  <th className="px-5 py-3 font-medium">Video ID</th>
                  <th className="px-5 py-3 font-medium">Estado</th>
                  <th className="hidden px-5 py-3 font-medium md:table-cell">Tamaño</th>
                  <th className="hidden px-5 py-3 font-medium lg:table-cell">Detectado</th>
                  <th className="px-5 py-3 text-right font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {vods.map((v) => (
                  <tr key={v.vod_id} className="transition-colors hover:bg-elevated/50">
                    <td className="px-5 py-3 font-medium text-fg">{v.channel}</td>
                    <td className="px-5 py-3 font-mono text-xs text-muted">{v.video_id}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={v.status} />
                    </td>
                    <td className="hidden px-5 py-3 text-muted md:table-cell">
                      {formatBytes(v.file_size_mb)}
                    </td>
                    <td className="hidden px-5 py-3 text-muted lg:table-cell">
                      {formatRelative(v.detected_at)}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {v.youtube_id && (
                          <a
                            href={`https://youtu.be/${v.youtube_id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-bg hover:text-accent"
                            title="Ver en YouTube"
                          >
                            <ExternalLink size={15} />
                          </a>
                        )}
                        <button
                          onClick={() => retry.mutate(v.vod_id)}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-bg hover:text-fg"
                          title="Reencolar"
                        >
                          <RotateCcw size={15} />
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`¿Borrar ${v.video_id}?`)) remove.mutate(v.vod_id);
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-danger/10 hover:text-danger"
                          title="Borrar"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted">
          <span>
            Página {page} de {pages}
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
            >
              <ChevronLeft size={16} /> Anterior
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= pages}
              onClick={() => setOffset((o) => o + PAGE)}
            >
              Siguiente <ChevronRight size={16} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
