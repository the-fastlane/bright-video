import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = process.env.REINDEX_TEST_ROOT ?? path.join(root, 'videos-dev');
const timeoutMs = Number(process.env.REINDEX_TEST_TIMEOUT_MS ?? 30_000);

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url, predicate, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const value = await response.json();
        if (predicate(value)) return value;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const apiPort = await freePort();
const uiPort = await freePort();
const databasePath = path.join(root, 'data', `.reindex-smoke-${process.pid}.db`);
const child = spawn(process.execPath, ['--env-file=.env', 'server/start.mjs'], {
  cwd: root,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    VIDEO_SOURCE: 'local',
    VIDEO_ROOT: fixtureRoot,
    DATABASE_PATH: databasePath,
    WATCH_ENABLED: process.env.WATCH_ENABLED ?? 'true',
    PORT: String(apiPort),
    UI_PORT: String(uiPort),
  },
});
let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk;
});
child.stderr.on('data', (chunk) => {
  output += chunk;
});
const baseUrl = `http://127.0.0.1:${apiPort}`;
const deadline = Date.now() + timeoutMs;
try {
  await waitFor(`${baseUrl}/api/health`, (health) => health.ok === true, deadline);
  const response = await fetch(`${baseUrl}/api/reindex`, { method: 'POST' });
  if (!response.ok) throw new Error(`Reindex returned HTTP ${response.status}`);
  const result = await waitFor(
    `${baseUrl}/api/scan-status`,
    (status) => status.active === false && status.completedAt !== null,
    deadline,
  );
  if (!result.total) throw new Error('Reindex discovered zero media files');
  if (result.processed !== result.total) {
    throw new Error(`Reindex processed ${result.processed}/${result.total}`);
  }
  if (result.errors) {
    const first = result.errorDetails?.[0];
    throw new Error(`Reindex reported ${result.errors} errors: ${first?.error ?? 'unknown error'}`);
  }
  const catalog = await (await fetch(`${baseUrl}/api/videos`)).json();
  const metadataRecord = catalog.videos?.find(
    (video) =>
      Number.isFinite(video.width) &&
      video.width > 0 &&
      Number.isFinite(video.height) &&
      video.height > 0,
  );
  if (!metadataRecord) throw new Error('Reindex produced no record with valid dimensions');
  console.log(`Reindex smoke passed: ${result.processed}/${result.total}, errors=0`);
} catch (error) {
  console.error(output);
  throw error;
} finally {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  await fs.rm(databasePath, { force: true });
  await fs.rm(`${databasePath}-wal`, { force: true });
  await fs.rm(`${databasePath}-shm`, { force: true });
}
