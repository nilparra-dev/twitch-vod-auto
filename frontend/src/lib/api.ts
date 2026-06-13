// Cliente tipado de la API FastAPI. Mismo origen → la cookie de sesión viaja
// automáticamente. Un 401 se traduce a UnauthorizedError para que el router
// redirija al login.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "No autenticado") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    ...init,
  });

  if (res.status === 401) throw new UnauthorizedError();

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const detail =
      (body as { detail?: string; error?: string })?.detail ??
      (body as { error?: string })?.error ??
      res.statusText;
    throw new ApiError(res.status, String(detail));
  }
  return body as T;
}

function jsonInit(method: string, payload: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

// ---- Tipos ----

export interface Summary {
  total: number;
  pending: number;
  downloading: number;
  uploaded: number;
  failed: number;
}

export interface QueueSummary {
  total: number;
  queued: number;
  downloading: number;
}

export interface ChannelStat {
  channel: string;
  total_detected: number;
  total_uploaded: number;
  total_failed: number;
  last_check: string | null;
}

export interface Vod {
  vod_id: string;
  channel: string;
  video_id: string;
  source: string | null;
  detected_at: string | null;
  processed_at: string | null;
  status: string;
  youtube_id: string | null;
  error_message: string | null;
  file_path: string | null;
  file_size_mb: number | null;
  tracker_url: string | null;
  download_url: string | null;
}

export interface QueueItem {
  id: number;
  vod_id: string;
  channel: string;
  video_id: string;
  source: string | null;
  status: string;
  attempts: number;
  error: string | null;
  created_at: string | null;
}

export interface ActivityDay {
  day: string;
  total: number;
  uploaded: number;
  failed: number;
}

export interface Progress {
  vod_id: string;
  channel: string;
  video_id: string;
  status: string;
  stage?: string;
  message?: string;
  percent: number;
  speed?: string;
  eta?: string;
  file_size_mb?: number;
  total_size_mb?: number;
  downloaded_mb?: number;
  encoded_mb?: number;
  elapsed_seconds?: number;
}

export interface DashboardState {
  summary: Summary;
  queue_summary: QueueSummary;
  channels: string[];
  stats: ChannelStat[];
  recent_vods: Vod[];
  activity: ActivityDay[];
  active_downloads: Record<string, Progress>;
  queue: QueueItem[];
}

export interface Me {
  user: string;
  admin_user: string;
}

export interface YouTubeStatus {
  client_secret_exists: boolean;
  client_secret_type: string;
  credentials: {
    exists: boolean;
    valid: boolean;
    expired: boolean | null;
    has_refresh_token: boolean;
    expiry: string | null;
    updated_at: string | null;
    error: string | null;
  };
  redirect_uri: string;
  installed_redirect_uri: string;
  mode: string;
  ready: boolean;
}

export interface VodsResponse {
  vods: Vod[];
  total: number;
  limit: number;
  offset: number;
}

// ---- Endpoints ----

export const api = {
  me: () => request<Me>("/api/me"),

  login: (user: string, password: string) =>
    request<{ status: string; user: string }>("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user, password }).toString(),
    }),

  logout: () => request<{ status: string }>("/api/logout", { method: "POST" }),

  vods: (params: {
    status?: string;
    channel?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== "" && v !== null) q.set(k, String(v));
    });
    return request<VodsResponse>(`/api/vods?${q.toString()}`);
  },

  vodDetail: (id: string) => request<Vod>(`/api/vods/${encodeURIComponent(id)}`),
  retryVod: (id: string) =>
    request<{ status: string }>(`/api/vods/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  deleteVod: (id: string) =>
    request<{ status: string }>(`/api/vods/${encodeURIComponent(id)}`, { method: "DELETE" }),

  queue: () => request<{ queue: QueueItem[] }>("/api/queue"),
  deleteQueue: (id: string) =>
    request<{ status: string }>(`/api/queue/${encodeURIComponent(id)}`, { method: "DELETE" }),

  activity: (days = 14) => request<{ activity: ActivityDay[] }>(`/api/activity?days=${days}`),

  logs: (lines = 200) => request<{ logs: string[] }>(`/api/logs?lines=${lines}`),

  manualUpload: (payload: {
    url_or_id: string;
    channel?: string;
    title?: string;
    privacy?: string;
    tags?: string[];
  }) => request<{ status: string; vod_id: string }>("/api/manual_upload", jsonInit("POST", payload)),

  youtubeStatus: () => request<YouTubeStatus>("/api/youtube/oauth/status"),
  youtubeStart: () =>
    request<{ authorization_url: string; redirect_uri: string; mode: string }>(
      "/api/youtube/oauth/start",
      { method: "POST" },
    ),
  youtubeComplete: (callback_url: string) =>
    request<{ status: string }>("/api/youtube/oauth/complete", jsonInit("POST", { callback_url })),
};
