import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { clearLine, cursorTo, moveCursor } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import chokidar from 'chokidar';
import { CatalogDatabase } from './catalog-db.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staticRoot = path.join(root, 'dist', 'bright-video', 'browser');
const videoSource = (process.env.VIDEO_SOURCE ?? 'local').trim().toLowerCase();
const configuredVideoRoot =
  videoSource === 'nas'
    ? (process.env.NAS_VIDEO_ROOT ?? '/mnt/synology_nfs_share')
    : (process.env.VIDEO_ROOT ?? path.join(root, 'videos'));
if (videoSource !== 'local' && videoSource !== 'nas') {
  throw new Error(`VIDEO_SOURCE must be either "local" or "nas", received "${videoSource}"`);
}
const videoRoot = path.resolve(configuredVideoRoot);
const databasePath = path.resolve(
  process.env.DATABASE_PATH ?? path.join(root, 'data', 'bright-video.db'),
);
const port = Number(process.env.PORT ?? 3000);
const mediaExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv']);
const sidecarSuffix = '.supplemental-metadata.json';
const metadataSignatureVersion = 'media-metadata-v3';
const configuredScanConcurrency = Number(process.env.SCAN_CONCURRENCY ?? 4);
const scanConcurrency = Number.isInteger(configuredScanConcurrency)
  ? Math.max(1, configuredScanConcurrency)
  : 4;
const configuredExifToolConcurrency = Number(process.env.EXIFTOOL_CONCURRENCY ?? 4);
const exifToolConcurrency = Number.isInteger(configuredExifToolConcurrency)
  ? Math.max(1, Math.min(scanConcurrency, configuredExifToolConcurrency))
  : Math.min(scanConcurrency, 4);
// A NAS read of a large moov atom regularly exceeds a second; too short a timeout means the
// file is never persisted and gets retried on every future scan.
const configuredScanFileTimeout = Number(
  process.env.SCAN_FILE_TIMEOUT_MS ?? (videoSource === 'nas' ? 5_000 : 1_000),
);
const scanFileTimeoutMs = Number.isFinite(configuredScanFileTimeout)
  ? Math.max(500, configuredScanFileTimeout)
  : 5_000;
// Network filesystems pay a round trip per stat, so fan them out far wider than CPU work.
const configuredStatConcurrency = Number(process.env.STAT_CONCURRENCY ?? 64);
const statConcurrency = Number.isInteger(configuredStatConcurrency)
  ? Math.max(1, configuredStatConcurrency)
  : 64;
// Matches the NFS rsize so each stream read maps onto a single network read.
const streamChunkSize = 1 << 20;
const openRangeChunkSize = 4 * 1024 * 1024;
const videoCacheMaxAgeSeconds = Number(process.env.VIDEO_CACHE_MAX_AGE ?? 86_400);
const statCacheTtlMs = Number(process.env.STAT_CACHE_TTL_MS ?? 60_000);
const statCacheMaxEntries = 20_000;
const watchEnabled = (process.env.WATCH_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
// Polling every second across a NAS library floods it with stat calls and starves streaming.
const configuredWatchInterval = Number(
  process.env.WATCH_INTERVAL_MS ?? (videoSource === 'nas' ? 60_000 : 1_000),
);
const watchIntervalMs = Number.isFinite(configuredWatchInterval)
  ? Math.max(1_000, configuredWatchInterval)
  : 60_000;
const exiftoolPath = path.resolve(root, 'node_modules', 'exiftool-vendored.pl', 'bin', 'exiftool');
const database = new CatalogDatabase(databasePath);
const monthFormatter = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' });
let catalog = database.listVideos().map(recordFromDatabase);
let catalogPayload = null;
let catalogVersion = 0;
let lastScan = null;
let scanStatus = {
  active: false,
  processed: 0,
  total: 0,
  estimatedRemainingMs: null,
  errors: 0,
  currentFile: null,
  currentPhase: null,
  errorDetails: [],
  startedAt: null,
  completedAt: null,
};
let scanInFlight;
let stopScanRequested = false;
let pendingPaths = new Set();
let scanTimer;
let terminalProgressDrawn = false;

class ExifToolWorker {
  child;
  output = '';
  request;
  timer;
  queue = [];

  ensureStarted() {
    if (this.child) return;
    const child = spawn(exiftoolPath, ['-stay_open', 'True', '-@', '-'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.child = child;
    child.stdout.on('data', (chunk) => {
      this.output += chunk.toString();
      const markerIndex = this.output.indexOf('{ready}');
      if (markerIndex < 0 || !this.request) return;
      const payload = this.output.slice(0, markerIndex).trim();
      this.output = this.output.slice(markerIndex + '{ready}'.length);
      try {
        this.finishRequest(null, JSON.parse(payload));
      } catch (error) {
        this.finishRequest(error);
      }
    });
    child.on('error', (error) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.finishRequest(error);
    });
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.request) this.finishRequest(new Error('ExifTool process exited unexpectedly'));
    });
  }

  finishRequest(error, value) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const request = this.request;
    this.request = undefined;
    if (!request) return;
    if (error) request.reject(error);
    else request.resolve(value);
    this.pump();
  }

  reset(error) {
    const child = this.child;
    this.child = undefined;
    this.output = '';
    child?.kill('SIGKILL');
    this.finishRequest(error);
  }

  cancel(error = new Error('Metadata scan stopped')) {
    const queued = this.queue.splice(0);
    for (const request of queued) request.reject(error);
    if (this.request) this.reset(error);
  }

  pump() {
    if (this.request || !this.queue.length) return;
    this.ensureStarted();
    const next = this.queue.shift();
    this.request = next;
    this.timer = setTimeout(
      () => this.reset(new Error(`Timed out during metadata after ${scanFileTimeoutMs / 1000}s`)),
      scanFileTimeoutMs,
    );
    try {
      this.child.stdin.write(
        [
          '-json',
          '-ImageWidth',
          '-ImageHeight',
          '-Rotation',
          '-VideoRotation',
          '-Duration',
          '-CreateDate',
          '-MediaCreateDate',
          '-TrackCreateDate',
          '-CreationDate',
          '-GPSLatitude',
          '-GPSLongitude',
          '-GPSAltitude',
          next.file,
          '-execute',
        ].join('\n') + '\n',
      );
    } catch (error) {
      this.reset(error);
    }
  }

  read(file) {
    return new Promise((resolve, reject) => {
      this.queue.push({ file, resolve, reject });
      this.pump();
    });
  }

  get pendingCount() {
    return this.queue.length + (this.request ? 1 : 0);
  }

  close() {
    this.child?.kill('SIGTERM');
    this.child = undefined;
  }
}

const metadataTools = Array.from({ length: exifToolConcurrency }, () => new ExifToolWorker());

function metadataToolForFile() {
  return metadataTools.reduce((leastBusy, tool) =>
    tool.pendingCount < leastBusy.pendingCount ? tool : leastBusy,
  );
}

process.on('exit', () => metadataTools.forEach((tool) => tool.close()));

function isVideo(file) {
  return mediaExtensions.has(path.extname(file).toLowerCase());
}

function isSidecar(file) {
  return /\.supplemental-metadata(?:\(\d+\))?\.json$/i.test(file);
}

function videoForSidecar(file) {
  const match = file.match(/^(.*?)(?:\.supplemental-metadata)(?:\((\d+)\))?\.json$/i);
  if (!match) return file;
  const mediaFile = match[1];
  const duplicateNumber = match[2];
  if (!duplicateNumber) return mediaFile;
  const extension = path.extname(mediaFile);
  return `${mediaFile.slice(0, -extension.length)}(${duplicateNumber})${extension}`;
}

function sidecarCandidates(file) {
  const candidates = [`${file}${sidecarSuffix}`];
  const mediaName = path.basename(file);
  const duplicate = mediaName.match(/^(.*)\((\d+)\)(\.[^.]+)$/);
  if (duplicate) {
    const originalFile = path.join(path.dirname(file), `${duplicate[1]}${duplicate[3]}`);
    candidates.unshift(
      `${originalFile}.supplemental-metadata(${duplicate[2]}).json`,
      `${originalFile}${sidecarSuffix}`,
    );
  }
  return candidates;
}

function numericValue(value) {
  const number = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(number) ? number : 0;
}

function durationMilliseconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 1000);
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.includes(':')) {
    const parts = text.split(':').map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) {
      return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
    }
    if (parts.length === 2 && parts.every(Number.isFinite)) {
      return Math.round((parts[0] * 60 + parts[1]) * 1000);
    }
  }
  const number = Number.parseFloat(text);
  return Number.isFinite(number) ? Math.round(number * 1000) : null;
}

function dateMilliseconds(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  const text = String(value ?? '').trim();
  if (!text) return null;
  const quickTime = text.match(
    /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}:?\d{2})?$/,
  );
  if (quickTime) {
    const [, year, month, day, hour, minute, second, fraction = '0'] = quickTime;
    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(`0.${fraction}`) * 1000,
    );
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstDateMilliseconds(...values) {
  for (const value of values.flat()) {
    const timestamp = dateMilliseconds(value);
    if (timestamp !== null) return timestamp;
  }
  return null;
}

function hasQuarterTurn(value) {
  const rotation = Math.abs(numericValue(value)) % 360;
  return rotation === 90 || rotation === 270;
}

async function readMediaMetadata(file) {
  try {
    const [tags] = await metadataToolForFile().read(file);
    const rawWidth = Number.isFinite(Number(tags.ImageWidth)) ? Number(tags.ImageWidth) : null;
    const rawHeight = Number.isFinite(Number(tags.ImageHeight)) ? Number(tags.ImageHeight) : null;
    const rotated = hasQuarterTurn(tags.Rotation ?? tags.VideoRotation);
    return {
      latitude: numericValue(tags.GPSLatitude),
      longitude: numericValue(tags.GPSLongitude),
      altitude: numericValue(tags.GPSAltitude),
      durationMs: durationMilliseconds(tags.Duration),
      captureDateMs: firstDateMilliseconds(
        tags.CreateDate,
        tags.MediaCreateDate,
        tags.TrackCreateDate,
        tags.CreationDate,
        tags.DateTimeOriginal,
      ),
      width: rotated ? rawHeight : rawWidth,
      height: rotated ? rawWidth : rawHeight,
    };
  } catch (error) {
    throw new Error(`ExifTool metadata read failed: ${error.message}`);
  }
}

async function fallbackSidecarMetadata(file, stat, mediaMetadata) {
  const timestampMs =
    mediaMetadata.captureDateMs ??
    (Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs);
  const timestamp = Math.floor(timestampMs / 1000);
  return {
    title: path.basename(file),
    description: '',
    imageViews: '0',
    creationTime: {
      timestamp: String(timestamp),
      formatted: new Date(timestampMs).toISOString(),
    },
    geoData: {
      latitude: mediaMetadata.latitude,
      longitude: mediaMetadata.longitude,
      altitude: mediaMetadata.altitude,
      latitudeSpan: 0,
      longitudeSpan: 0,
    },
    geoDataExif: {
      latitude: mediaMetadata.latitude,
      longitude: mediaMetadata.longitude,
      altitude: mediaMetadata.altitude,
      latitudeSpan: 0,
      longitudeSpan: 0,
    },
  };
}

function isGeneratedFallbackMetadata(file, metadata) {
  return (
    metadata?.title === path.basename(file) &&
    !metadata.photoTakenTime &&
    !metadata.url &&
    !metadata.googlePhotosOrigin
  );
}

async function createFallbackSidecar(file, stat, mediaMetadata) {
  const sidecar = `${file}${sidecarSuffix}`;
  const metadata = await fallbackSidecarMetadata(file, stat, mediaMetadata);
  try {
    await fs.writeFile(sidecar, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
    return { metadata, path: sidecar };
  } catch (error) {
    if (error.code !== 'EEXIST') {
    }
    return { metadata, path: null };
  }
}

async function readSidecar(file, stat, mediaMetadata) {
  for (const sidecar of sidecarCandidates(file)) {
    try {
      const metadata = JSON.parse(await fs.readFile(sidecar, 'utf8'));
      if (isGeneratedFallbackMetadata(file, metadata) && mediaMetadata.captureDateMs) {
        const corrected = await fallbackSidecarMetadata(file, stat, mediaMetadata);
        await fs.writeFile(sidecar, `${JSON.stringify(corrected, null, 2)}\n`);
        return { metadata: corrected, path: sidecar };
      }
      return {
        metadata,
        path: sidecar,
      };
    } catch (error) {
      if (error.code !== 'ENOENT')
        return {
          metadata: { metadataWarning: 'Unable to parse supplemental metadata' },
          path: sidecar,
        };
    }
  }
  return createFallbackSidecar(file, stat, mediaMetadata);
}

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true, recursive: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    files.push(path.join(entry.parentPath ?? entry.path ?? directory, entry.name));
  }
  return files;
}

async function mapConcurrent(items, limit, worker) {
  let index = 0;
  const run = async () => {
    while (index < items.length) {
      const current = index++;
      await worker(items[current], current);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

function toRelativePath(file) {
  return path.relative(videoRoot, file).split(path.sep).join('/');
}

function fileSignature(stat, sidecarStat) {
  return `${metadataSignatureVersion}:${stat.size}:${stat.mtimeMs}:${sidecarStat?.size ?? 0}:${sidecarStat?.mtimeMs ?? 0}`;
}

async function firstExistingSidecarStat(file, knownFiles) {
  for (const candidate of sidecarCandidates(file)) {
    if (knownFiles && !knownFiles.has(candidate)) continue;
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat) return { stat, path: candidate };
  }
  return { stat: null, path: null };
}

function parseTimestamp(value) {
  const timestamp = Number(value ?? 0);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp * 1000).toISOString()
    : null;
}

function recordFromMetadata(file, metadata, stat, mediaMetadata) {
  const relativePath = toRelativePath(file);
  const captureDate =
    parseTimestamp(metadata.photoTakenTime?.timestamp ?? metadata.creationTime?.timestamp) ??
    (mediaMetadata.captureDateMs ? new Date(mediaMetadata.captureDateMs).toISOString() : null);
  return {
    id: relativePath,
    title: metadata.title?.replace(/\.[^.]+$/, '') || path.basename(file, path.extname(file)),
    filename: path.basename(file),
    path: relativePath,
    url: `/videos/${relativePath.split('/').map(encodeURIComponent).join('/')}`,
    captureDate,
    year: captureDate ? new Date(captureDate).getUTCFullYear() : null,
    month: captureDate ? monthFormatter.format(new Date(captureDate)) : 'Undated',
    monthKey: captureDate ? captureDate.slice(0, 7) : 'undated',
    description: metadata.description ?? '',
    format: path.extname(file).slice(1).toUpperCase(),
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    durationMs: mediaMetadata.durationMs,
    width: mediaMetadata.width,
    height: mediaMetadata.height,
    latitude: mediaMetadata.latitude,
    longitude: mediaMetadata.longitude,
    altitude: mediaMetadata.altitude,
    metadataSource: 'exiftool',
    metadataWarning: metadata.metadataWarning,
  };
}

function recordFromDatabase(row) {
  const captureDate = row.capture_date;
  return {
    id: row.file_path,
    title: row.title,
    filename: row.filename,
    path: row.file_path,
    url: `/videos/${row.file_path.split('/').map(encodeURIComponent).join('/')}`,
    captureDate,
    year: captureDate ? new Date(captureDate).getUTCFullYear() : null,
    month: captureDate ? monthFormatter.format(new Date(captureDate)) : 'Undated',
    monthKey: captureDate ? captureDate.slice(0, 7) : 'undated',
    description: row.description,
    format: row.format,
    size: row.file_size,
    modifiedAt: row.modified_at,
    durationMs: row.duration_ms,
    width: row.width,
    height: row.height,
    metadataWarning: row.metadata_warning ?? undefined,
  };
}

async function readRecord(file, onPhase = () => {}, force = false, precomputed = null) {
  let phase = 'filesystem';
  onPhase(phase);
  try {
    // The pre-scan pass already paid for these stats; reuse them instead of hitting the NAS twice.
    const stat = precomputed?.stat ?? (await fs.stat(file));
    const signature =
      precomputed?.signature ??
      fileSignature(stat, (await firstExistingSidecarStat(file, precomputed?.knownFiles)).stat);
    phase = 'database';
    onPhase(phase);
    if (!precomputed?.stale) {
      const existing = database.getVideo(toRelativePath(file));
      if (!force && existing?.file_signature === signature && existing.width && existing.height)
        return { ok: true };
    }
    phase = 'metadata';
    onPhase(phase);
    const mediaMetadata = await readMediaMetadata(file);
    phase = 'sidecar';
    onPhase(phase);
    const { metadata, path: sidecar } = await readSidecar(file, stat, mediaMetadata);
    phase = 'database';
    onPhase(phase);
    const sidecarStat = sidecar ? await fs.stat(sidecar).catch(() => null) : null;
    database.upsertVideo({
      ...recordFromMetadata(file, metadata, stat, mediaMetadata),
      fileSignature: fileSignature(stat, sidecarStat),
    });
    return { ok: true };
  } catch (error) {
    if (error.code === 'ENOENT') database.removeVideo(toRelativePath(file));
    return {
      ok: false,
      phase,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function rebuildCatalog() {
  catalog = database.listVideos().map(recordFromDatabase);
  catalogPayload = null;
  catalogVersion += 1;
  lastScan = new Date().toISOString();
}

function updateScanTerminal(status, done = false) {
  if (!status.total) return;
  const suffix = status.currentFile ? ` ${status.currentFile} (${status.currentPhase})` : '';
  const remaining = status.estimatedRemainingMs
    ? `, about ${Math.ceil(status.estimatedRemainingMs / 1000)}s remaining`
    : '';
  const summary = done
    ? `Scan complete: ${status.processed}/${status.total}${status.errors ? `, ${status.errors} skipped` : ''}`
    : `Scanning: ${status.processed}/${status.total}${remaining}${status.errors ? `, ${status.errors} skipped` : ''}${suffix}`;
  const terminalSummary = process.stdout.columns
    ? summary.slice(0, Math.max(1, process.stdout.columns - 1))
    : summary;
  if (process.stdout.isTTY) {
    if (terminalProgressDrawn) moveCursor(process.stdout, 0, -1);
    cursorTo(process.stdout, 0);
    clearLine(process.stdout, 0);
    process.stdout.write(terminalSummary);
    if (done) {
      process.stdout.write('\n');
      terminalProgressDrawn = false;
    } else {
      terminalProgressDrawn = true;
    }
    return;
  }
  if (terminalProgressDrawn) process.stdout.write('\x1b[1A');
  process.stdout.write(`\x1b[2K\r${terminalSummary}${done ? '\n' : ''}`);
  terminalProgressDrawn = !done;
}

function estimatedRemainingMs(status) {
  if (!status.processed || !status.total || status.processed >= status.total) return null;
  const startedAt = Date.parse(status.startedAt ?? '');
  if (!Number.isFinite(startedAt)) return null;
  const elapsedMs = Date.now() - startedAt;
  return Math.max(
    0,
    Math.round((elapsedMs / status.processed) * (status.total - status.processed)),
  );
}

async function scanLibrary(changedPaths = null, force = false, contexts = null) {
  if (scanInFlight) {
    if (changedPaths) changedPaths.forEach((file) => pendingPaths.add(file));
    return scanInFlight;
  }
  scanStatus = {
    active: true,
    processed: 0,
    total: 0,
    estimatedRemainingMs: null,
    errors: 0,
    currentFile: null,
    currentPhase: null,
    errorDetails: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  stopScanRequested = false;
  scanInFlight = (async () => {
    const files = changedPaths ? [...changedPaths] : await walk(videoRoot);
    const mediaFiles = changedPaths
      ? files.flatMap((file) =>
          isSidecar(file) ? [videoForSidecar(file)] : isVideo(file) ? [file] : [],
        )
      : files.filter(isVideo);
    scanStatus = { ...scanStatus, total: mediaFiles.length };
    updateScanTerminal(scanStatus);
    let nextIndex = 0;
    const processNext = async () => {
      while (nextIndex < mediaFiles.length) {
        if (stopScanRequested) return;
        const file = mediaFiles[nextIndex++];
        if (!isVideo(file)) continue;
        scanStatus = {
          ...scanStatus,
          currentFile: path.relative(videoRoot, file),
          currentPhase: 'filesystem',
        };
        const result = await readRecord(
          file,
          (phase) => {
            scanStatus = { ...scanStatus, currentPhase: phase };
          },
          force,
          contexts?.get(file) ?? null,
        );
        scanStatus = {
          ...scanStatus,
          processed: scanStatus.processed + 1,
          estimatedRemainingMs: estimatedRemainingMs({
            ...scanStatus,
            processed: scanStatus.processed + 1,
          }),
        };
        if (!result.ok) {
          const detail = {
            file: path.relative(videoRoot, file),
            phase: result.phase ?? 'unknown',
            error: result.error ?? 'Unknown indexing error',
          };
          scanStatus = {
            ...scanStatus,
            errors: scanStatus.errors + 1,
            errorDetails: [...scanStatus.errorDetails, detail],
          };
        }
        updateScanTerminal(scanStatus);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(scanConcurrency, mediaFiles.length) }, processNext),
    );
    if (!stopScanRequested && !changedPaths) {
      database.removeMissingVideoPaths(mediaFiles.map(toRelativePath));
    }
    rebuildCatalog();
    scanStatus = {
      ...scanStatus,
      active: false,
      currentFile: null,
      currentPhase: null,
      completedAt: new Date().toISOString(),
      estimatedRemainingMs: null,
      stopped: stopScanRequested,
    };
    updateScanTerminal(scanStatus, true);
  })().finally(async () => {
    scanInFlight = undefined;
    if (stopScanRequested) {
      pendingPaths = new Set();
      return;
    }
    if (pendingPaths.size) {
      const nextPaths = pendingPaths;
      pendingPaths = new Set();
      await scanLibrary(nextPaths);
    }
  });
  return scanInFlight;
}

async function findFilesNeedingScan() {
  const allFiles = await walk(videoRoot);
  const knownFiles = new Set(allFiles);
  const mediaFiles = allFiles.filter(isVideo);
  const indexed = new Map(database.listSignatures().map((row) => [row.file_path, row]));
  const contexts = new Map();
  await mapConcurrent(mediaFiles, statConcurrency, async (file) => {
    const relativePath = toRelativePath(file);
    const existing = indexed.get(relativePath);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) return;
    const { stat: sidecarStat } = await firstExistingSidecarStat(file, knownFiles);
    const signature = fileSignature(stat, sidecarStat);
    if (existing && existing.file_signature === signature && existing.width && existing.height)
      return;
    contexts.set(file, { stat, signature, stale: true, knownFiles });
  });
  return { files: [...contexts.keys()], contexts };
}

function queueChangedPath(file) {
  if (stopScanRequested) return;
  pendingPaths.add(file);
  clearTimeout(scanTimer);
  scanTimer = setTimeout(async () => {
    const changed = pendingPaths;
    pendingPaths = new Set();
    await scanLibrary(changed);
  }, 250);
}

function startWatcher() {
  if (!watchEnabled) {
    console.log('Watcher disabled; use the Scan action to pick up changes');
    return null;
  }
  const watcher = chokidar.watch(videoRoot, {
    ignoreInitial: true,
    persistent: true,
    // Network mounts do not deliver native events, but polling must stay slow enough
    // that it never competes with playback reads.
    usePolling: videoSource === 'nas',
    interval: watchIntervalMs,
    binaryInterval: watchIntervalMs,
    awaitWriteFinish: { stabilityThreshold: 2_000, pollInterval: 500 },
    ignored: (file) => file !== videoRoot && file.includes(`${path.sep}.`),
  });
  watcher.on('add', queueChangedPath).on('change', queueChangedPath).on('unlink', queueChangedPath);
  watcher.on('error', (error) => console.error('Video watcher error:', error));
  console.log(
    `Watching ${videoRoot} for new and changed videos (${videoSource === 'nas' ? `polling every ${Math.round(watchIntervalMs / 1000)}s` : 'native events'})`,
  );
  return watcher;
}

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function acceptsGzip(request) {
  return /\bgzip\b/.test(request.headers['accept-encoding'] ?? '');
}

// The unfiltered catalog is identical for every client and only changes on rescan,
// so serialize and compress it once per catalog version.
function catalogResponse() {
  if (!catalogPayload) {
    const body = Buffer.from(JSON.stringify({ videos: catalog }));
    catalogPayload = {
      body,
      gzipped: gzipSync(body, { level: 6 }),
      etag: `"catalog-${catalogVersion}-${body.length.toString(36)}"`,
    };
  }
  return catalogPayload;
}

function sendCatalog(request, response) {
  const payload = catalogResponse();
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    etag: payload.etag,
    vary: 'accept-encoding',
  };
  if (request.headers['if-none-match'] === payload.etag) {
    response.writeHead(304, headers);
    return response.end();
  }
  const compressed = acceptsGzip(request);
  const body = compressed ? payload.gzipped : payload.body;
  if (compressed) headers['content-encoding'] = 'gzip';
  headers['content-length'] = body.length;
  response.writeHead(200, headers);
  if (request.method === 'HEAD') return response.end();
  response.end(body);
}

function albumNameTaken(name, excludeId = null) {
  const normalized = String(name).trim().toLocaleLowerCase();
  return database
    .listAlbums()
    .some(
      (album) => album.id !== excludeId && album.name.trim().toLocaleLowerCase() === normalized,
    );
}

async function requestBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

const videoStatCache = new Map();

async function cachedVideoStat(file) {
  const cached = videoStatCache.get(file);
  if (cached && cached.expires > Date.now()) return cached.stat;
  const stat = await fs.stat(file);
  if (videoStatCache.size >= statCacheMaxEntries) videoStatCache.clear();
  videoStatCache.set(file, { stat, expires: Date.now() + statCacheTtlMs });
  return stat;
}

const videoContentTypes = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
};

function isClientAbort(error) {
  return (
    error?.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    error?.code === 'ECONNRESET' ||
    error?.code === 'EPIPE'
  );
}

async function serveVideo(request, response, pathname) {
  const relativePath = decodeURIComponent(pathname.slice('/videos/'.length));
  const file = path.resolve(videoRoot, relativePath);
  if (!file.startsWith(`${videoRoot}${path.sep}`))
    return json(response, 403, { error: 'Forbidden path' });
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return json(response, 405, { error: 'Method not allowed' });
  let stat;
  try {
    stat = await cachedVideoStat(file);
    if (!stat.isFile()) return json(response, 404, { error: 'Not found' });
  } catch {
    return json(response, 404, { error: 'Video not found' });
  }

  const extension = path.extname(file).toLowerCase();
  const type = videoContentTypes[extension] ?? 'video/quicktime';
  const etag = `"${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}"`;
  const lastModified = new Date(stat.mtimeMs).toUTCString();
  const validators = {
    etag,
    'last-modified': lastModified,
    'accept-ranges': 'bytes',
    'cache-control': `private, max-age=${videoCacheMaxAgeSeconds}`,
  };
  const range = request.headers.range;

  // Revalidation only applies to whole-resource requests; ranged reads must still be served.
  if (!range && request.headers['if-none-match'] === etag) {
    response.writeHead(304, validators);
    return response.end();
  }

  try {
    if (!range) {
      response.writeHead(200, { ...validators, 'content-type': type, 'content-length': stat.size });
      if (request.method === 'HEAD') return response.end();
      await pipeline(createReadStream(file, { highWaterMark: streamChunkSize }), response);
      return;
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return json(response, 416, { error: 'Invalid range' });
    const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2] || 1));
    const requestedEnd = match[2] ? Number(match[2]) : start + openRangeChunkSize - 1;
    if (!Number.isInteger(start) || start < 0 || start >= stat.size)
      return json(response, 416, { error: 'Range not satisfiable' });
    const end = Math.min(requestedEnd, stat.size - 1);
    response.writeHead(206, {
      ...validators,
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
    });
    if (request.method === 'HEAD') return response.end();
    await pipeline(
      createReadStream(file, { start, end, highWaterMark: streamChunkSize }),
      response,
    );
  } catch (error) {
    // Browsers abort media requests constantly while scrolling; that is not an error.
    if (isClientAbort(error)) return;
    if (!response.headersSent) json(response, 404, { error: 'Video not found' });
  }
}

async function serveStatic(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const requestedPath = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const candidate = path.resolve(staticRoot, `.${requestedPath}`);
  const file = candidate.startsWith(`${staticRoot}${path.sep}`) ? candidate : staticRoot;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('Not a file');
    const contentTypes = {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
    };
    response.writeHead(200, {
      'content-type': contentTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': stat.size,
      'cache-control':
        path.basename(file) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    if (request.method === 'HEAD') response.end();
    else await pipeline(createReadStream(file), response);
    return true;
  } catch {
    if (pathname !== '/') return serveStatic(request, response, '/');
    return false;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname === '/api/health')
      return json(response, 200, { ok: true, count: catalog.length, lastScan, watching: true });
    if (url.pathname === '/api/videos') {
      const query = url.searchParams.get('q')?.toLowerCase().trim();
      const minDurationValue = url.searchParams.get('minDurationMs');
      const maxDurationValue = url.searchParams.get('maxDurationMs');
      const albumIdValue = url.searchParams.get('albumId');
      const minDuration = minDurationValue === null ? null : Number(minDurationValue);
      const maxDuration = maxDurationValue === null ? null : Number(maxDurationValue);
      const albumId = albumIdValue === null ? null : Number(albumIdValue);
      const hasFilters =
        query ||
        Number.isFinite(minDuration) ||
        Number.isFinite(maxDuration) ||
        Number.isInteger(albumId);
      if (!hasFilters) return sendCatalog(request, response);
      const videos = database
        .listVideos(query ?? '', {
          minDurationMs: Number.isFinite(minDuration) ? minDuration : null,
          maxDurationMs: Number.isFinite(maxDuration) ? maxDuration : null,
          albumId: Number.isInteger(albumId) ? albumId : null,
        })
        .map(recordFromDatabase);
      return json(response, 200, { videos });
    }
    if (url.pathname === '/api/albums' && request.method === 'GET')
      return json(response, 200, { albums: database.listAlbums() });
    if (url.pathname === '/api/scan-status' && request.method === 'GET')
      return json(response, 200, scanStatus);
    if (url.pathname === '/api/albums' && request.method === 'POST') {
      const body = await requestBody(request);
      if (!String(body.name ?? '').trim())
        return json(response, 400, { error: 'Album name is required' });
      if (albumNameTaken(body.name))
        return json(response, 409, { error: 'An album with this name already exists' });
      return json(response, 201, { album: database.createAlbum(body) });
    }
    const albumMatch = url.pathname.match(/^\/api\/albums\/(\d+)$/);
    if (albumMatch && request.method === 'PATCH') {
      const body = await requestBody(request);
      if (!String(body.name ?? '').trim())
        return json(response, 400, { error: 'Album name is required' });
      if (albumNameTaken(body.name, Number(albumMatch[1])))
        return json(response, 409, { error: 'An album with this name already exists' });
      return json(response, 200, { album: database.updateAlbum(Number(albumMatch[1]), body) });
    }
    if (albumMatch && request.method === 'DELETE') {
      database.deleteAlbum(Number(albumMatch[1]));
      return json(response, 204, {});
    }
    const videoAlbumsMatch = url.pathname.match(/^\/api\/videos\/(.+)\/albums$/);
    if (videoAlbumsMatch && request.method === 'GET') {
      const videoPath = decodeURIComponent(videoAlbumsMatch[1]);
      const albumIds = database.listVideoAlbumIds(videoPath);
      if (!albumIds) return json(response, 404, { error: 'Video not found' });
      return json(response, 200, { albumIds });
    }
    if (videoAlbumsMatch && request.method === 'PUT') {
      const body = await requestBody(request);
      const videoPath = decodeURIComponent(videoAlbumsMatch[1]);
      if (!Array.isArray(body.albumIds) || !database.setVideoAlbums(videoPath, body.albumIds))
        return json(response, 400, { error: 'Invalid video or album list' });
      return json(response, 200, { ok: true });
    }
    if (url.pathname === '/api/scan' && request.method === 'POST') {
      void findFilesNeedingScan().then(({ files, contexts }) =>
        scanLibrary(files, false, contexts),
      );
      return json(response, 202, { started: true, mode: 'scan' });
    }
    if (url.pathname === '/api/scan-stop' && request.method === 'POST') {
      stopScanRequested = true;
      clearTimeout(scanTimer);
      scanTimer = undefined;
      pendingPaths = new Set();
      metadataTools.forEach((tool) => tool.cancel());
      return json(response, 202, { stopping: Boolean(scanInFlight) });
    }
    if (url.pathname === '/api/reindex' && request.method === 'POST') {
      void scanLibrary(null, true);
      return json(response, 202, { started: true, mode: 'reindex' });
    }
    if (url.pathname.startsWith('/videos/')) return serveVideo(request, response, url.pathname);
    if (await serveStatic(request, response, url.pathname)) return;
    return json(response, 404, { error: 'Not found' });
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : 'Unexpected error' });
  }
});

startWatcher();
// Media playback reuses connections heavily; keep them alive longer than the browser's idle window.
server.keepAliveTimeout = 70_000;
server.headersTimeout = 75_000;
server.requestTimeout = 0;
server.listen(port, () => console.log(`Bright Video API listening on http://localhost:${port}`));
