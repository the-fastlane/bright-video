import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
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
const metadataSignatureVersion = 'rotation-v2';
const configuredScanConcurrency = Number(process.env.SCAN_CONCURRENCY ?? 4);
const scanConcurrency = Number.isInteger(configuredScanConcurrency)
  ? Math.max(1, configuredScanConcurrency)
  : 4;
const scanFileTimeoutMs = 1_000;
const exiftoolPath = path.resolve(root, 'node_modules', 'exiftool-vendored.pl', 'bin', 'exiftool');
const database = new CatalogDatabase(databasePath);
let catalog = database.listVideos().map(recordFromDatabase);
let lastScan = null;
let scanStatus = {
  active: false,
  processed: 0,
  total: 0,
  errors: 0,
  currentFile: null,
  currentPhase: null,
  errorDetails: [],
  startedAt: null,
  completedAt: null,
};
let scanInFlight;
let pendingPaths = new Set();
let scanTimer;

class ExifToolWorker {
  child;
  output = '';
  request;
  timer;

  ensureStarted() {
    if (this.child) return;
    this.child = spawn(exiftoolPath, ['-stay_open', 'True', '-@', '-'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.child.stdout.on('data', (chunk) => {
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
    this.child.on('error', (error) => this.finishRequest(error));
    this.child.on('exit', () => {
      if (this.request) this.finishRequest(new Error('ExifTool process exited unexpectedly'));
      this.child = undefined;
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
  }

  reset(error) {
    this.finishRequest(error);
    this.output = '';
    this.child?.kill('SIGKILL');
    this.child = undefined;
  }

  async read(file) {
    this.ensureStarted();
    return new Promise((resolve, reject) => {
      this.request = { resolve, reject };
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
            '-GPSLatitude',
            '-GPSLongitude',
            '-GPSAltitude',
            file,
            '-execute',
          ].join('\n') + '\n',
        );
      } catch (error) {
        this.reset(error);
      }
    });
  }

  close() {
    this.child?.kill('SIGTERM');
    this.child = undefined;
  }
}

const metadataTool = new ExifToolWorker();
process.on('exit', () => metadataTool.close());

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

function hasQuarterTurn(value) {
  const rotation = Math.abs(numericValue(value)) % 360;
  return rotation === 90 || rotation === 270;
}

async function readMediaMetadata(file) {
  try {
    const [tags] = await metadataTool.read(file);
    const rawWidth = Number.isFinite(Number(tags.ImageWidth)) ? Number(tags.ImageWidth) : null;
    const rawHeight = Number.isFinite(Number(tags.ImageHeight)) ? Number(tags.ImageHeight) : null;
    const rotated = hasQuarterTurn(tags.Rotation ?? tags.VideoRotation);
    return {
      latitude: numericValue(tags.GPSLatitude),
      longitude: numericValue(tags.GPSLongitude),
      altitude: numericValue(tags.GPSAltitude),
      durationMs: durationMilliseconds(tags.Duration),
      width: rotated ? rawHeight : rawWidth,
      height: rotated ? rawWidth : rawHeight,
    };
  } catch (error) {
    throw new Error(`ExifTool metadata read failed: ${error.message}`);
  }
}

async function fallbackSidecarMetadata(file, stat, mediaMetadata) {
  const timestampMs =
    Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
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
      return {
        metadata: JSON.parse(await fs.readFile(sidecar, 'utf8')),
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
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const children = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(fullPath) : fullPath;
    }),
  );
  return children.flat();
}

function parseTimestamp(value) {
  const timestamp = Number(value ?? 0);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp * 1000).toISOString()
    : null;
}

function recordFromMetadata(file, metadata, stat, mediaMetadata) {
  const relativePath = path.relative(videoRoot, file).split(path.sep).join('/');
  const captureDate = parseTimestamp(
    metadata.photoTakenTime?.timestamp ?? metadata.creationTime?.timestamp,
  );
  return {
    id: relativePath,
    title: metadata.title?.replace(/\.[^.]+$/, '') || path.basename(file, path.extname(file)),
    filename: path.basename(file),
    path: relativePath,
    url: `/videos/${relativePath.split('/').map(encodeURIComponent).join('/')}`,
    captureDate,
    year: captureDate ? new Date(captureDate).getUTCFullYear() : null,
    month: captureDate
      ? new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(
          new Date(captureDate),
        )
      : 'Undated',
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
    month: captureDate
      ? new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(
          new Date(captureDate),
        )
      : 'Undated',
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

async function readRecord(file, onPhase = () => {}) {
  let phase = 'filesystem';
  onPhase(phase);
  try {
    const stat = await fs.stat(file);
    let sidecarStat = null;
    for (const candidate of sidecarCandidates(file)) {
      sidecarStat = await fs.stat(candidate).catch(() => null);
      if (sidecarStat) break;
    }
    const signature = `${metadataSignatureVersion}:${stat.size}:${stat.mtimeMs}:${sidecarStat?.size ?? 0}:${sidecarStat?.mtimeMs ?? 0}`;
    phase = 'database';
    onPhase(phase);
    const existing = database.getVideo(path.relative(videoRoot, file).split(path.sep).join('/'));
    if (existing?.file_signature === signature && existing.width && existing.height)
      return { ok: true };
    phase = 'metadata';
    onPhase(phase);
    const mediaMetadata = await readMediaMetadata(file);
    phase = 'sidecar';
    onPhase(phase);
    const { metadata, path: sidecar } = await readSidecar(file, stat, mediaMetadata);
    phase = 'database';
    onPhase(phase);
    sidecarStat = sidecar ? await fs.stat(sidecar).catch(() => null) : null;
    database.upsertVideo({
      ...recordFromMetadata(file, metadata, stat, mediaMetadata),
      fileSignature: signature,
    });
    return { ok: true };
  } catch (error) {
    if (error.code === 'ENOENT') {
      database.removeVideo(path.relative(videoRoot, file).split(path.sep).join('/'));
    }
    return {
      ok: false,
      phase,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readRecordWithTimeout(file, onPhase) {
  return readRecord(file, onPhase);
}

function rebuildCatalog() {
  catalog = database.listVideos().map(recordFromDatabase);
  lastScan = new Date().toISOString();
}

function updateScanTerminal(status, done = false) {
  if (!status.total) return;
  const suffix = status.currentFile ? ` ${status.currentFile} (${status.currentPhase})` : '';
  const summary = done
    ? `Scan complete: ${status.processed}/${status.total}${status.errors ? `, ${status.errors} skipped` : ''}`
    : `Scanning: ${status.processed}/${status.total}${status.errors ? `, ${status.errors} skipped` : ''}${suffix}`;
  process.stdout.write(`\r\x1b[2K${summary}${done ? '\n' : ''}`);
}

async function scanLibrary(changedPaths = null) {
  if (scanInFlight) {
    if (changedPaths) changedPaths.forEach((file) => pendingPaths.add(file));
    return scanInFlight;
  }
  if (!changedPaths) {
    scanStatus = {
      active: true,
      processed: 0,
      total: 0,
      errors: 0,
      currentFile: null,
      currentPhase: null,
      errorDetails: [],
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
  }
  scanInFlight = (async () => {
    const files = changedPaths ? [...changedPaths] : await walk(videoRoot);
    const mediaFiles = changedPaths
      ? files.flatMap((file) =>
          isSidecar(file) ? [videoForSidecar(file)] : isVideo(file) ? [file] : [],
        )
      : files.filter(isVideo);
    if (!changedPaths) {
      scanStatus = {
        active: true,
        processed: 0,
        total: mediaFiles.length,
        errors: 0,
        currentFile: null,
        currentPhase: null,
        errorDetails: [],
        startedAt: new Date().toISOString(),
        completedAt: null,
      };
      updateScanTerminal(scanStatus);
    }
    let nextIndex = 0;
    const processNext = async () => {
      while (nextIndex < mediaFiles.length) {
        const file = mediaFiles[nextIndex++];
        if (!isVideo(file)) continue;
        if (!changedPaths) {
          scanStatus = {
            ...scanStatus,
            currentFile: path.relative(videoRoot, file),
            currentPhase: 'filesystem',
          };
        }
        const result = await readRecordWithTimeout(file, (phase) => {
          if (!changedPaths) scanStatus = { ...scanStatus, currentPhase: phase };
        });
        if (!changedPaths) {
          scanStatus = { ...scanStatus, processed: scanStatus.processed + 1 };
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
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(scanConcurrency, mediaFiles.length) }, processNext),
    );
    if (!changedPaths) {
      const currentFiles = new Set(mediaFiles);
      database.removeMissingVideoPaths(
        [...currentFiles].map((file) => path.relative(videoRoot, file).split(path.sep).join('/')),
      );
    }
    rebuildCatalog();
    if (!changedPaths) {
      scanStatus = {
        ...scanStatus,
        active: false,
        currentFile: null,
        currentPhase: null,
        completedAt: new Date().toISOString(),
      };
      updateScanTerminal(scanStatus, true);
    }
  })().finally(async () => {
    scanInFlight = undefined;
    if (pendingPaths.size) {
      const nextPaths = pendingPaths;
      pendingPaths = new Set();
      await scanLibrary(nextPaths);
    }
  });
  return scanInFlight;
}

function queueChangedPath(file) {
  pendingPaths.add(file);
  clearTimeout(scanTimer);
  scanTimer = setTimeout(async () => {
    const changed = pendingPaths;
    pendingPaths = new Set();
    await scanLibrary(changed);
  }, 250);
}

function startWatcher() {
  const watcher = chokidar.watch(videoRoot, {
    ignoreInitial: true,
    persistent: true,
    usePolling: true,
    interval: 1_000,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    ignored: (file) => file !== videoRoot && file.includes(`${path.sep}.`),
  });
  watcher.on('add', queueChangedPath).on('change', queueChangedPath).on('unlink', queueChangedPath);
  watcher.on('error', (error) => console.error('Video watcher error:', error));
  console.log(`Watching ${videoRoot} for new and changed videos`);
  return watcher;
}

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
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

async function serveVideo(request, response, pathname) {
  const relativePath = decodeURIComponent(pathname.slice('/videos/'.length));
  const file = path.resolve(videoRoot, relativePath);
  if (!file.startsWith(`${videoRoot}${path.sep}`))
    return json(response, 403, { error: 'Forbidden path' });
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return json(response, 404, { error: 'Not found' });
    const extension = path.extname(file).toLowerCase();
    const type =
      extension === '.mp4' ? 'video/mp4' : extension === '.webm' ? 'video/webm' : 'video/quicktime';
    const range = request.headers.range;
    if (!range) {
      response.writeHead(200, {
        'content-type': type,
        'content-length': stat.size,
        'accept-ranges': 'bytes',
      });
      await pipeline(createReadStream(file), response);
      return;
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return json(response, 416, { error: 'Invalid range' });
    const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2] || 1));
    const requestedEnd = match[2] ? Number(match[2]) : start + 4 * 1024 * 1024 - 1;
    if (!Number.isInteger(start) || start < 0 || start >= stat.size)
      return json(response, 416, { error: 'Range not satisfiable' });
    const end = Math.min(requestedEnd, stat.size - 1);
    response.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'accept-ranges': 'bytes',
    });
    await pipeline(createReadStream(file, { start, end }), response);
  } catch {
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
      const videos = hasFilters
        ? database
            .listVideos(query ?? '', {
              minDurationMs: Number.isFinite(minDuration) ? minDuration : null,
              maxDurationMs: Number.isFinite(maxDuration) ? maxDuration : null,
              albumId: Number.isInteger(albumId) ? albumId : null,
            })
            .map(recordFromDatabase)
        : catalog;
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
    if (url.pathname === '/api/rescan' && request.method === 'POST') {
      void scanLibrary();
      return json(response, 202, { started: true });
    }
    if (url.pathname.startsWith('/videos/')) return serveVideo(request, response, url.pathname);
    if (await serveStatic(request, response, url.pathname)) return;
    return json(response, 404, { error: 'Not found' });
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : 'Unexpected error' });
  }
});

const startupScan = scanLibrary();
startWatcher();
server.listen(port, () => console.log(`Bright Video API listening on http://localhost:${port}`));
