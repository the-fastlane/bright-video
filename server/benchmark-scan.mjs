import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { pipeline } from 'node:stream/promises';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import { ExifTool } from 'exiftool-vendored';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const videoSource = (process.env.VIDEO_SOURCE ?? 'nas').trim().toLowerCase();
const videoRoot =
  videoSource === 'nas'
    ? (process.env.NAS_VIDEO_ROOT ?? '/Volumes/video-nfs')
    : (process.env.VIDEO_ROOT ?? path.join(root, 'videos'));
const sampleSize = Number(process.env.BENCHMARK_SAMPLE_SIZE ?? 500);
const concurrency = Number(process.env.BENCHMARK_CONCURRENCY ?? 12);
const exiftoolPath = path.resolve(root, 'node_modules', 'exiftool-vendored.pl', 'bin', 'exiftool');

const mediaExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv']);

class FastExifToolWorker {
  child;
  output = '';
  request;
  timer;
  queue = [];

  ensureStarted() {
    if (this.child) return;
    const child = spawn('/usr/bin/perl', [exiftoolPath, '-stay_open', 'True', '-@', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr.resume();
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

  pump() {
    if (this.request || !this.queue.length) return;
    this.ensureStarted();
    const next = this.queue.shift();
    this.request = next;
    this.timer = setTimeout(() => this.finishRequest(new Error('Timeout')), 5000);
    try {
      this.child.stdin.write(
        [
          '-json',
          '-fast',
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
      this.finishRequest(error);
    }
  }

  read(file) {
    return new Promise((resolve, reject) => {
      this.queue.push({ file, resolve, reject });
      this.pump();
    });
  }

  close() {
    this.child?.kill('SIGTERM');
    this.child = undefined;
  }
}

async function walk(dir, maxFiles) {
  const files = [];
  const queue = [dir];
  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        queue.push(fullPath);
      } else if (entry.isFile() && mediaExtensions.has(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

async function runPool(items, limit, fn, name = '') {
  let index = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      await fn(items[i], i);
      done++;
      if (name && (done % 100 === 0 || done === items.length)) {
        process.stdout.write(`    ↳ [${name}] processed ${done}/${items.length}\n`);
      }
    }
  });
  await Promise.all(workers);
}

// 1. Persistent stay_open ExifTool worker pool with -fast
async function benchmarkStayOpenExifTool(files, poolSize) {
  const pool = Array.from({ length: poolSize }, () => new FastExifToolWorker());
  const start = Date.now();
  let errors = 0;
  await runPool(
    files,
    poolSize,
    async (file, i) => {
      const worker = pool[i % poolSize];
      try {
        await worker.read(file);
      } catch {
        errors++;
      }
    },
    'Metadata',
  );
  pool.forEach((w) => w.close());
  const elapsed = (Date.now() - start) / 1000;
  return {
    name: `Persistent Stay-Open ExifTool Pool (-fast, workers=${poolSize})`,
    elapsed,
    fps: (files.length / elapsed).toFixed(1),
    errors,
  };
}

// 2. Current Thumbnail Pipeline (FFmpeg PNG stream -> Sharp WebP)
async function benchmarkCurrentThumbnailPipeline(files, tempDir, poolSize) {
  const start = Date.now();
  let errors = 0;
  await runPool(
    files,
    poolSize,
    async (file, i) => {
      const out = path.join(tempDir, `current-thumb-${i}.webp`);
      const ffmpeg = spawn(ffmpegPath, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        '1',
        '-i',
        file,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        '-',
      ]);
      const transformer = sharp()
        .resize({ width: 320, withoutEnlargement: true })
        .webp({ quality: 75, effort: 2 });
      let errorOutput = '';
      ffmpeg.stderr.on('data', (chunk) => (errorOutput += chunk.toString()));
      const ffmpegExit = new Promise((resolve, reject) => {
        ffmpeg.once('error', reject);
        ffmpeg.once('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(errorOutput.trim() || `ffmpeg exited with ${code}`));
        });
      });
      try {
        const processing = pipeline(ffmpeg.stdout, transformer, createWriteStream(out));
        await Promise.all([processing, ffmpegExit]);
      } catch {
        errors++;
        ffmpeg.kill('SIGTERM');
      }
    },
    'Current Pipeline',
  );
  const elapsed = (Date.now() - start) / 1000;
  return {
    name: `Current (FFmpeg PNG Stream -> Sharp WebP, concurrency=${poolSize})`,
    elapsed,
    fps: (files.length / elapsed).toFixed(1),
    errors,
  };
}

// 3. Optimized VideoToolbox HW-Accelerated Direct WebP Generation
async function benchmarkVideoToolboxThumbnails(files, tempDir, poolSize) {
  const start = Date.now();
  let errors = 0;
  await runPool(
    files,
    poolSize,
    async (file, i) => {
      const out = path.join(tempDir, `opt-thumb-${i}.webp`);
      await new Promise((resolve) => {
        const proc = spawn(ffmpegPath, [
          '-hide_banner',
          '-loglevel',
          'error',
          '-hwaccel',
          'videotoolbox',
          '-ss',
          '1',
          '-i',
          file,
          '-vf',
          'scale=320:-1:force_original_aspect_ratio=decrease',
          '-frames:v',
          '1',
          '-c:v',
          'libwebp',
          '-quality',
          '75',
          '-compression_level',
          '2',
          '-y',
          out,
        ]);
        proc.on('close', (code) => {
          if (code !== 0) errors++;
          resolve();
        });
        proc.on('error', () => {
          errors++;
          resolve();
        });
      });
    },
    'Optimized Pipeline',
  );
  const elapsed = (Date.now() - start) / 1000;
  return {
    name: `Optimized M3 (FFmpeg VideoToolbox -> Direct WebP, concurrency=${poolSize})`,
    elapsed,
    fps: (files.length / elapsed).toFixed(1),
    errors,
  };
}

async function main() {
  console.log(`\n======================================================`);
  console.log(`🚀 Bright Video M3 Benchmark on NAS`);
  console.log(`======================================================`);
  console.log(`Target directory: ${videoRoot}`);
  console.log(`CPU Cores: ${availableParallelism()}, Concurrency: ${concurrency}`);

  const files = await walk(videoRoot, sampleSize);
  console.log(`Discovered ${files.length} video files for benchmark (Target: >= ${sampleSize})\n`);

  if (files.length === 0) {
    console.error('❌ No video files found. Check NAS_VIDEO_ROOT or mount status.');
    process.exit(1);
  }

  const tempDir = path.join(root, 'data', '.benchmark-temp-thumbs');
  await fs.mkdir(tempDir, { recursive: true });

  console.log('--- Phase 1: Metadata Extraction (500 Videos) ---');
  const metadataResult = await benchmarkStayOpenExifTool(files, concurrency);
  console.log(
    `📊 ${metadataResult.name}\n    Time: ${metadataResult.elapsed.toFixed(2)}s | Speed: ${metadataResult.fps} files/sec | Errors: ${metadataResult.errors}\n`,
  );

  console.log('--- Phase 2: Thumbnail Generation (500 Videos) ---');
  const currentThumbResult = await benchmarkCurrentThumbnailPipeline(files, tempDir, concurrency);
  console.log(
    `📊 [Current Pipeline] ${currentThumbResult.name}\n    Time: ${currentThumbResult.elapsed.toFixed(2)}s | Speed: ${currentThumbResult.fps} files/sec | Errors: ${currentThumbResult.errors}\n`,
  );

  const optThumbResult = await benchmarkVideoToolboxThumbnails(files, tempDir, concurrency);
  console.log(
    `📊 [Optimized M3 Pipeline] ${optThumbResult.name}\n    Time: ${optThumbResult.elapsed.toFixed(2)}s | Speed: ${optThumbResult.fps} files/sec | Errors: ${optThumbResult.errors}\n`,
  );

  await fs.rm(tempDir, { recursive: true, force: true });
  console.log('======================================================');
  console.log('🏁 Benchmark Summary:');
  console.log(
    `  • Thumbnail Speedup on M3: ${(currentThumbResult.elapsed / optThumbResult.elapsed).toFixed(2)}x faster (${optThumbResult.fps} vs ${currentThumbResult.fps} files/sec)`,
  );
  console.log(
    `  • Time Saved per 500 files: ${(currentThumbResult.elapsed - optThumbResult.elapsed).toFixed(1)}s`,
  );
  console.log('======================================================\n');
}

main().catch(console.error);
