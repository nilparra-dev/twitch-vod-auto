import os
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime


class PipelineDB:
    def __init__(self, db_path: str = "data/pipeline.db"):
        self.db_path = db_path
        dirname = os.path.dirname(db_path)
        if dirname:
            os.makedirs(dirname, exist_ok=True)
        self._init_db()

    def _raw_connect(self):
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    @contextmanager
    def _connect(self):
        conn = self._raw_connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_db(self):
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA synchronous = NORMAL")
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS processed_vods (
                    vod_id TEXT PRIMARY KEY,
                    channel TEXT NOT NULL,
                    video_id TEXT NOT NULL,
                    source TEXT,
                    detected_at TEXT,
                    processed_at TEXT,
                    status TEXT DEFAULT 'pending',
                    youtube_id TEXT,
                    error_message TEXT,
                    file_path TEXT,
                    file_size_mb REAL,
                    tracker_url TEXT,
                    download_url TEXT
                );

                CREATE TABLE IF NOT EXISTS channel_stats (
                    channel TEXT PRIMARY KEY,
                    total_detected INTEGER DEFAULT 0,
                    total_uploaded INTEGER DEFAULT 0,
                    total_failed INTEGER DEFAULT 0,
                    last_check TEXT
                );

                CREATE TABLE IF NOT EXISTS download_queue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    vod_id TEXT UNIQUE NOT NULL,
                    channel TEXT NOT NULL,
                    video_id TEXT NOT NULL,
                    source TEXT,
                    start_time INTEGER,
                    tracker_url TEXT,
                    download_url TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    status TEXT DEFAULT 'queued',
                    attempts INTEGER DEFAULT 0,
                    error TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_vods_channel ON processed_vods(channel);
                CREATE INDEX IF NOT EXISTS idx_vods_status ON processed_vods(status);
                CREATE INDEX IF NOT EXISTS idx_queue_status ON download_queue(status);
            """)
            self._ensure_column(conn, "processed_vods", "tracker_url", "TEXT")
            self._ensure_column(conn, "processed_vods", "download_url", "TEXT")
            self._ensure_column(conn, "download_queue", "tracker_url", "TEXT")
            self._ensure_column(conn, "download_queue", "download_url", "TEXT")

    @staticmethod
    def _ensure_column(conn, table: str, column: str, col_type: str):
        existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")

    # --- Processed VODs ---

    def is_processed(self, vod_id: str) -> bool:
        with self._connect() as conn:
            row = conn.execute("SELECT 1 FROM processed_vods WHERE vod_id = ?", (vod_id,)).fetchone()
            return row is not None

    def add_vod(
        self,
        vod_id: str,
        channel: str,
        video_id: str,
        source: str,
        status: str = "pending",
        error: str = None,
        file_path: str = None,
        file_size_mb: float = None,
        tracker_url: str = None,
        download_url: str = None,
    ):
        with self._connect() as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO processed_vods
                (vod_id, channel, video_id, source, detected_at, status, error_message,
                 file_path, file_size_mb, tracker_url, download_url)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    vod_id,
                    channel,
                    video_id,
                    source,
                    datetime.now(UTC).isoformat(),
                    status,
                    error,
                    file_path,
                    file_size_mb,
                    tracker_url,
                    download_url,
                ),
            )

    def update_vod_status(
        self,
        vod_id: str,
        status: str,
        youtube_id: str = None,
        error: str = None,
        file_path: str = None,
        file_size_mb: float = None,
    ):
        with self._connect() as conn:
            sets = ["status = ?", "processed_at = ?"]
            vals = [status, datetime.now(UTC).isoformat()]
            if youtube_id is not None:
                sets.append("youtube_id = ?")
                vals.append(youtube_id)
            if error is not None:
                sets.append("error_message = ?")
                vals.append(error)
            if file_path is not None:
                sets.append("file_path = ?")
                vals.append(file_path)
            if file_size_mb is not None:
                sets.append("file_size_mb = ?")
                vals.append(file_size_mb)
            vals.append(vod_id)
            conn.execute(f"UPDATE processed_vods SET {', '.join(sets)} WHERE vod_id = ?", vals)

    def get_vod(self, vod_id: str) -> dict | None:
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM processed_vods WHERE vod_id = ?", (vod_id,)).fetchone()
            return dict(row) if row else None

    def get_vods(
        self,
        status: str = None,
        channel: str = None,
        search: str = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict]:
        limit = max(1, min(int(limit), 100))
        offset = max(0, int(offset))
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            where = []
            params = []
            if status:
                where.append("status = ?")
                params.append(status)
            if channel:
                where.append("LOWER(channel) = LOWER(?)")
                params.append(channel)
            if search:
                where.append("(vod_id LIKE ? OR channel LIKE ? OR video_id LIKE ?)")
                like = f"%{search}%"
                params.extend([like, like, like])
            query = "SELECT * FROM processed_vods"
            if where:
                query += " WHERE " + " AND ".join(where)
            query += " ORDER BY detected_at DESC LIMIT ? OFFSET ?"
            params.extend([limit, offset])
            rows = conn.execute(query, params).fetchall()
            return [dict(r) for r in rows]

    def count_vods(self, status: str = None, channel: str = None, search: str = None) -> int:
        with self._connect() as conn:
            where = []
            params = []
            if status:
                where.append("status = ?")
                params.append(status)
            if channel:
                where.append("LOWER(channel) = LOWER(?)")
                params.append(channel)
            if search:
                where.append("(vod_id LIKE ? OR channel LIKE ? OR video_id LIKE ?)")
                like = f"%{search}%"
                params.extend([like, like, like])
            query = "SELECT COUNT(*) FROM processed_vods"
            if where:
                query += " WHERE " + " AND ".join(where)
            row = conn.execute(query, params).fetchone()
            return row[0] if row else 0

    def reset_vod(self, vod_id: str):
        """Reset a VOD record before requeueing it explicitly."""
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE processed_vods
                SET status = 'pending', processed_at = NULL, error_message = NULL, youtube_id = NULL
                WHERE vod_id = ?
            """,
                (vod_id,),
            )

    def delete_vod(self, vod_id: str):
        with self._connect() as conn:
            conn.execute("DELETE FROM processed_vods WHERE vod_id = ?", (vod_id,))
            conn.execute("DELETE FROM download_queue WHERE vod_id = ?", (vod_id,))

    def get_summary_counts(self) -> dict:
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT
                    COUNT(*) as total,
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                    SUM(CASE WHEN status IN ('downloading', 'encoding', 'uploading') THEN 1 ELSE 0 END) as downloading,
                    SUM(CASE WHEN status = 'uploaded' THEN 1 ELSE 0 END) as uploaded,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
                FROM processed_vods
            """).fetchone()
            return dict(row) if row else {"total": 0, "pending": 0, "downloading": 0, "uploaded": 0, "failed": 0}

    def get_daily_activity(self, days: int = 7) -> list[dict]:
        days = max(1, min(int(days), 90))
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT
                    date(detected_at) as day,
                    COUNT(*) as total,
                    SUM(CASE WHEN status = 'uploaded' THEN 1 ELSE 0 END) as uploaded,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
                FROM processed_vods
                WHERE detected_at >= date('now', ?)
                GROUP BY date(detected_at)
                ORDER BY day ASC
            """,
                (f"-{days} days",),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_channels(self) -> list[str]:
        with self._connect() as conn:
            rows = conn.execute("SELECT DISTINCT channel FROM processed_vods ORDER BY channel").fetchall()
            return [r[0] for r in rows]

    # --- Queue ---

    def enqueue(self, stream_info: dict, force: bool = False):
        with self._connect() as conn:
            values = (
                stream_info["vod_id"],
                stream_info["channel"],
                stream_info["video_id"],
                stream_info.get("source"),
                stream_info.get("start_time"),
                stream_info.get("tracker_url"),
                stream_info.get("download_url"),
            )
            if force:
                conn.execute(
                    """
                    INSERT INTO download_queue
                        (vod_id, channel, video_id, source, start_time, tracker_url, download_url, status, attempts, error)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL)
                    ON CONFLICT(vod_id) DO UPDATE SET
                        channel = excluded.channel,
                        video_id = excluded.video_id,
                        source = excluded.source,
                        start_time = excluded.start_time,
                        tracker_url = excluded.tracker_url,
                        download_url = excluded.download_url,
                        status = 'queued',
                        attempts = 0,
                        error = NULL
                """,
                    values,
                )
            else:
                try:
                    conn.execute(
                        """
                        INSERT INTO download_queue (vod_id, channel, video_id, source, start_time, tracker_url, download_url)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                        values,
                    )
                except sqlite3.IntegrityError:
                    pass

    def dequeue(self) -> dict | None:
        conn = self._raw_connect()
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("""
                SELECT * FROM download_queue
                WHERE status = 'queued'
                ORDER BY created_at, id
                LIMIT 1
            """).fetchone()
            if not row:
                conn.commit()
                return None
            conn.execute("UPDATE download_queue SET status = 'downloading', error = NULL WHERE id = ?", (row["id"],))
            conn.commit()
            return dict(row)
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def mark_queue_status(self, vod_id: str, status: str, error: str = None):
        with self._connect() as conn:
            if status == "failed":
                conn.execute(
                    """
                    UPDATE download_queue SET status = ?, error = ?, attempts = attempts + 1
                    WHERE vod_id = ?
                """,
                    (status, error, vod_id),
                )
            else:
                conn.execute(
                    "UPDATE download_queue SET status = ?, error = NULL WHERE vod_id = ?",
                    (status, vod_id),
                )

    def delete_from_queue(self, vod_id: str):
        with self._connect() as conn:
            conn.execute("DELETE FROM download_queue WHERE vod_id = ?", (vod_id,))

    def get_queue_summary(self) -> dict:
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT
                    COUNT(*) as total,
                    SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
                    SUM(CASE WHEN status IN ('downloading', 'encoding', 'downloaded', 'uploading') THEN 1 ELSE 0 END) as downloading
                FROM download_queue
            """).fetchone()
            return dict(row) if row else {"total": 0, "queued": 0, "downloading": 0}

    # --- Stats ---

    def increment_stat(self, channel: str, field: str):
        fields = {"detected": "total_detected", "uploaded": "total_uploaded", "failed": "total_failed"}
        col = fields.get(field)
        if not col:
            return
        with self._connect() as conn:
            conn.execute(
                f"""
                INSERT INTO channel_stats (channel, {col}, last_check)
                VALUES (?, 1, ?)
                ON CONFLICT(channel) DO UPDATE SET
                {col} = {col} + 1,
                last_check = excluded.last_check
            """,
                (channel, datetime.now(UTC).isoformat()),
            )

    def get_stats(self) -> list[dict]:
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("SELECT * FROM channel_stats").fetchall()
            return [dict(r) for r in rows]


if __name__ == "__main__":
    db = PipelineDB("data/test.db")
    print("Database initialized at", db.db_path)
