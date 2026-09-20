import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const schema = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY,
    file_path TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    modified_at REAL NOT NULL,
    capture_date TEXT,
    duration_ms INTEGER,
    width INTEGER,
    height INTEGER,
    latitude REAL,
    longitude REAL,
    altitude REAL,
    metadata_warning TEXT,
    metadata_source TEXT,
    metadata_updated_at TEXT NOT NULL,
    file_signature TEXT NOT NULL,
    thumbnail_path TEXT,
    people TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS videos_capture_date_idx ON videos(capture_date);
  CREATE INDEX IF NOT EXISTS videos_duration_idx ON videos(duration_ms);

  CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS album_videos (
    album_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL,
    PRIMARY KEY (album_id, video_id),
    FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS album_videos_video_idx ON album_videos(video_id);

  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS video_tags (
    video_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    confidence REAL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (video_id, tag_id, source),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS video_analysis (
    video_id INTEGER PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    summary TEXT NOT NULL DEFAULT '',
    provider TEXT,
    model TEXT,
    analyzed_at TEXT,
    error TEXT,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS analysis_jobs (
    id INTEGER PRIMARY KEY,
    video_id INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    error TEXT,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS video_search USING fts5(
    video_id UNINDEXED,
    title,
    description,
    summary,
    tags,
    people,
    location
  );
`;

function now() {
  return new Date().toISOString();
}

function normalizeSearch(value) {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => {
      const escaped = term.replaceAll('"', '""');
      return term.length >= 3 ? `"${escaped}"*` : `"${escaped}"`;
    })
    .join(' AND ');
}

// WAL plus relaxed fsync keeps the scan write path off the disk-sync critical path.
const tuning = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA temp_store = MEMORY;
  PRAGMA cache_size = -65536;
  PRAGMA mmap_size = 268435456;
`;

export class CatalogDatabase {
  #db;
  #upsertVideo;
  #deleteVideo;
  #selectVideo;
  #selectAll;
  #search;
  #deleteSearch;
  #insertSearch;
  #selectAlbums;
  #selectSignatures;
  #selectVideoPaths;
  #insertAnalysis;
  #insertAnalysisJob;

  constructor(file) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec(tuning);
    this.#db.exec(schema);
    const columns = this.#db.prepare('PRAGMA table_info(videos)').all();
    if (!columns.some((column) => column.name === 'thumbnail_path'))
      this.#db.exec('ALTER TABLE videos ADD COLUMN thumbnail_path TEXT');
    if (!columns.some((column) => column.name === 'people'))
      this.#db.exec("ALTER TABLE videos ADD COLUMN people TEXT NOT NULL DEFAULT ''");
    if (!columns.some((column) => column.name === 'location'))
      this.#db.exec("ALTER TABLE videos ADD COLUMN location TEXT NOT NULL DEFAULT ''");
    const searchColumns = this.#db.prepare('PRAGMA table_info(video_search)').all();
    if (!searchColumns.some((column) => column.name === 'people')) {
      this.#db.exec('ALTER TABLE video_search RENAME TO video_search_legacy');
      this.#db.exec(`
        CREATE VIRTUAL TABLE video_search USING fts5(
          video_id UNINDEXED,
          title,
          description,
          summary,
          tags,
          people,
          location
        )
      `);
      this.#db.exec(`
        INSERT INTO video_search (video_id, title, description, summary, tags, people, location)
        SELECT legacy.video_id, legacy.title, legacy.description, legacy.summary, legacy.tags,
          COALESCE(videos.people, ''), COALESCE(videos.location, '')
        FROM video_search_legacy AS legacy
        LEFT JOIN videos ON videos.id = legacy.video_id
      `);
      this.#db.exec('DROP TABLE video_search_legacy');
    }
    this.#upsertVideo = this.#db.prepare(`
      INSERT INTO videos (
        file_path, filename, title, description, format, file_size, modified_at,
        capture_date, duration_ms, width, height, latitude, longitude, altitude,
        metadata_warning, metadata_source, metadata_updated_at, file_signature, thumbnail_path,
        people, location
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        filename = excluded.filename,
        title = excluded.title,
        description = excluded.description,
        format = excluded.format,
        file_size = excluded.file_size,
        modified_at = excluded.modified_at,
        capture_date = excluded.capture_date,
        duration_ms = excluded.duration_ms,
        width = excluded.width,
        height = excluded.height,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        altitude = excluded.altitude,
        metadata_warning = excluded.metadata_warning,
        metadata_source = excluded.metadata_source,
        metadata_updated_at = excluded.metadata_updated_at,
        file_signature = excluded.file_signature,
        thumbnail_path = excluded.thumbnail_path,
        people = excluded.people,
        location = excluded.location
      RETURNING id
    `);
    this.#deleteVideo = this.#db.prepare('DELETE FROM videos WHERE file_path = ?');
    this.#selectVideo = this.#db.prepare('SELECT * FROM videos WHERE file_path = ?');
    this.#selectAll = this.#db.prepare(
      'SELECT * FROM videos ORDER BY capture_date DESC NULLS LAST, file_path',
    );
    this.#search = this.#db.prepare(`
      SELECT videos.*
      FROM video_search
      JOIN videos ON videos.id = video_search.video_id
      WHERE video_search MATCH ?
      ORDER BY videos.capture_date DESC NULLS LAST, videos.file_path
    `);
    this.#deleteSearch = this.#db.prepare('DELETE FROM video_search WHERE video_id = ?');
    this.#insertSearch = this.#db.prepare(
      'INSERT INTO video_search (video_id, title, description, summary, tags, people, location) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.#selectAlbums = this.#db.prepare(
      'SELECT id, name, description, display_order, created_at, updated_at FROM albums ORDER BY display_order, id',
    );
    this.#selectSignatures = this.#db.prepare(
      'SELECT file_path, file_signature, width, height FROM videos',
    );
    this.#selectVideoPaths = this.#db.prepare('SELECT file_path FROM videos');
    this.#insertAnalysis = this.#db.prepare(`
      INSERT INTO video_analysis (video_id, status)
      VALUES (?, 'pending')
      ON CONFLICT(video_id) DO NOTHING
    `);
    this.#insertAnalysisJob = this.#db.prepare(`
      INSERT INTO analysis_jobs (video_id, available_at)
      VALUES (?, ?)
      ON CONFLICT(video_id) DO NOTHING
    `);
  }

  upsertVideo(video) {
    const row = this.#upsertVideo.get(
      video.path,
      video.filename,
      video.title,
      video.description,
      video.format,
      video.size,
      video.modifiedAt,
      video.captureDate,
      video.durationMs,
      video.width,
      video.height,
      video.latitude,
      video.longitude,
      video.altitude,
      video.metadataWarning ?? null,
      video.metadataSource ?? 'sidecar',
      now(),
      video.fileSignature,
      video.thumbnailPath ?? null,
      video.people ?? '',
      video.location ?? '',
    );
    const timestamp = now();
    this.#deleteSearch.run(row.id);
    this.#insertSearch.run(
      row.id,
      `${video.title} ${video.filename}`,
      video.description,
      '',
      '',
      video.people ?? '',
      video.location ?? '',
    );
    this.#insertAnalysis.run(row.id);
    this.#insertAnalysisJob.run(row.id, timestamp);
    return { id: row.id };
  }

  listSignatures() {
    return this.#selectSignatures.all();
  }

  transaction(run) {
    this.#db.exec('BEGIN');
    try {
      const result = run();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  removeMissingVideoPaths(paths) {
    const existing = new Set(paths);
    const stale = this.#selectVideoPaths
      .all()
      .filter((row) => !existing.has(row.file_path))
      .map((row) => row.file_path);
    if (!stale.length) return;
    this.transaction(() => stale.forEach((filePath) => this.#deleteVideo.run(filePath)));
  }

  clearVideos() {
    this.#db.exec('BEGIN; DELETE FROM video_search; DELETE FROM videos; COMMIT;');
  }

  removeVideo(filePath) {
    this.#deleteVideo.run(filePath);
  }

  getVideo(filePath) {
    return this.#selectVideo.get(filePath);
  }

  listVideos(query = '', { minDurationMs = null, maxDurationMs = null, albumId = null } = {}) {
    const normalized = normalizeSearch(query);
    const conditions = [];
    const parameters = [];
    if (normalized) {
      conditions.push('video_search MATCH ?');
      parameters.push(normalized);
    }
    if (Number.isFinite(minDurationMs)) {
      conditions.push('videos.duration_ms >= ?');
      parameters.push(minDurationMs);
    }
    if (Number.isFinite(maxDurationMs)) {
      conditions.push('videos.duration_ms <= ?');
      parameters.push(maxDurationMs);
    }
    if (Number.isInteger(albumId)) {
      conditions.push(
        'EXISTS (SELECT 1 FROM album_videos av WHERE av.video_id = videos.id AND av.album_id = ?)',
      );
      parameters.push(albumId);
    }
    const from = normalized
      ? 'FROM video_search JOIN videos ON videos.id = video_search.video_id'
      : 'FROM videos';
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    return this.#db
      .prepare(
        `SELECT videos.* ${from}${where} ORDER BY videos.capture_date DESC NULLS LAST, videos.file_path`,
      )
      .all(...parameters);
  }

  listAlbums() {
    return this.#selectAlbums.all();
  }

  createAlbum({ name, description = '', displayOrder = 0 }) {
    const timestamp = now();
    const result = this.#db
      .prepare(
        'INSERT INTO albums (name, description, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(name.trim(), description.trim(), displayOrder, timestamp, timestamp);
    return this.#db.prepare('SELECT * FROM albums WHERE id = ?').get(result.lastInsertRowid);
  }

  updateAlbum(id, { name, description = '', displayOrder = 0 }) {
    this.#db
      .prepare(
        'UPDATE albums SET name = ?, description = ?, display_order = ?, updated_at = ? WHERE id = ?',
      )
      .run(name.trim(), description.trim(), displayOrder, now(), id);
    return this.#db.prepare('SELECT * FROM albums WHERE id = ?').get(id);
  }

  deleteAlbum(id) {
    this.#db.prepare('DELETE FROM albums WHERE id = ?').run(id);
  }

  setVideoAlbums(videoPath, albumIds) {
    const video = this.getVideo(videoPath);
    if (!video) return false;
    this.#db.prepare('DELETE FROM album_videos WHERE video_id = ?').run(video.id);
    const insert = this.#db.prepare(
      'INSERT INTO album_videos (album_id, video_id, display_order, added_at) VALUES (?, ?, ?, ?)',
    );
    for (const [index, albumId] of albumIds.entries()) insert.run(albumId, video.id, index, now());
    return true;
  }

  listVideoAlbumIds(videoPath) {
    const video = this.getVideo(videoPath);
    if (!video) return null;
    return this.#db
      .prepare(
        'SELECT album_id FROM album_videos WHERE video_id = ? ORDER BY display_order, album_id',
      )
      .all(video.id)
      .map((row) => row.album_id);
  }

  getSetting(key, fallback = null) {
    return (
      this.#db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? fallback
    );
  }

  setSetting(key, value) {
    this.#db
      .prepare(
        'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, String(value));
  }

  claimAnalysisJob() {
    const job = this.#db
      .prepare(
        `
      SELECT analysis_jobs.id, analysis_jobs.video_id, videos.file_path, videos.thumbnail_path
      FROM analysis_jobs
      JOIN videos ON videos.id = analysis_jobs.video_id
      JOIN video_analysis ON video_analysis.video_id = videos.id
      WHERE analysis_jobs.status = 'pending'
        AND video_analysis.status IN ('pending', 'error')
        AND analysis_jobs.available_at <= ?
      ORDER BY analysis_jobs.priority DESC, analysis_jobs.id
      LIMIT 1
    `,
      )
      .get(now());
    if (!job) return null;
    this.#db
      .prepare(
        `
      UPDATE analysis_jobs
      SET status = 'running', attempts = attempts + 1, started_at = ?, error = NULL
      WHERE id = ? AND status = 'pending'
    `,
      )
      .run(now(), job.id);
    this.#db
      .prepare("UPDATE video_analysis SET status = 'running', error = NULL WHERE video_id = ?")
      .run(job.video_id);
    return job;
  }

  recoverAnalysisJobs() {
    this.transaction(() => {
      this.#db
        .prepare("UPDATE analysis_jobs SET status = 'pending', started_at = NULL WHERE status = 'running'")
        .run();
      this.#db
        .prepare("UPDATE video_analysis SET status = 'pending', error = NULL WHERE status = 'running'")
        .run();
    });
  }

  skipExhaustedAnalysisJobs(maxAttempts = 3) {
    const exhausted = this.#db
      .prepare(
        `
      SELECT analysis_jobs.video_id, videos.file_path, analysis_jobs.attempts, analysis_jobs.error
      FROM analysis_jobs
      JOIN videos ON videos.id = analysis_jobs.video_id
      WHERE analysis_jobs.attempts >= ?
        AND analysis_jobs.status IN ('pending', 'running', 'error')
    `,
      )
      .all(maxAttempts);
    if (!exhausted.length) return exhausted;
    this.transaction(() => {
      this.#db
        .prepare(
          "UPDATE analysis_jobs SET status = 'skipped', completed_at = ?, started_at = NULL WHERE attempts >= ? AND status IN ('pending', 'running', 'error')",
        )
        .run(now(), maxAttempts);
      this.#db
        .prepare(
          "UPDATE video_analysis SET status = 'skipped' WHERE video_id IN (SELECT video_id FROM analysis_jobs WHERE status = 'skipped' AND attempts >= ?)",
        )
        .run(maxAttempts);
    });
    return exhausted;
  }

  completeAnalysis(videoId, { summary, tags, provider, model }) {
    this.transaction(() => {
      this.#db
        .prepare(
          `
        UPDATE video_analysis
        SET status = 'complete', summary = ?, provider = ?, model = ?, analyzed_at = ?, error = NULL
        WHERE video_id = ?
      `,
        )
        .run(summary, provider, model, now(), videoId);
      this.#db
        .prepare(
          `
        UPDATE analysis_jobs SET status = 'complete', completed_at = ?, error = NULL WHERE video_id = ?
      `,
        )
        .run(now(), videoId);
      const video = this.#db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
      if (video) {
        this.#deleteSearch.run(videoId);
        this.#insertSearch.run(
          videoId,
          `${video.title} ${video.filename}`,
          video.description,
          summary,
          tags.join(' '),
          video.people ?? '',
          video.location ?? '',
        );
      }
    });
  }

  failAnalysis(videoId, error, { retry = true } = {}) {
    const attempts = this.#db
      .prepare('SELECT attempts FROM analysis_jobs WHERE video_id = ?')
      .get(videoId)?.attempts ?? 0;
    const shouldRetry = retry && attempts < 3;
    if (!shouldRetry) {
      this.#db
        .prepare("UPDATE video_analysis SET status = 'skipped', error = ? WHERE video_id = ?")
        .run(error, videoId);
      this.#db
        .prepare("UPDATE analysis_jobs SET status = 'skipped', completed_at = ?, error = ? WHERE video_id = ?")
        .run(now(), error, videoId);
      return { skipped: true, attempts };
    }
    this.#db
      .prepare("UPDATE video_analysis SET status = 'error', error = ? WHERE video_id = ?")
      .run(error, videoId);
    this.#db
      .prepare(
        "UPDATE analysis_jobs SET status = 'pending', available_at = ?, error = ? WHERE video_id = ?",
      )
      .run(new Date(Date.now() + 30_000).toISOString(), error, videoId);
    return { skipped: false, attempts };
  }

  analysisStatus() {
    return this.#db
      .prepare(
        `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS complete,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status IN ('pending', 'error') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
      FROM video_analysis
    `,
      )
      .get();
  }

  close() {
    this.#db.close();
  }
}
