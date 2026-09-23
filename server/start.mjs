import { spawn } from 'node:child_process';

const children = [];
let shuttingDown = false;
const baseEnv = {
  ...process.env,
  UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? '64',
};

function start(command, args) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: baseEnv,
  });
  children.push(child);
  return child;
}

let api = start(process.execPath, ['server/index.mjs']);
const uiEnvironment = { ...baseEnv };
delete uiEnvironment.PORT;
const ui = spawn('npm', ['run', 'start:ui', '--', '--port', uiEnvironment.UI_PORT ?? '4317'], {
  stdio: 'inherit',
  env: uiEnvironment,
});
children.push(ui);

function stop() {
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function handleApiExit(code) {
  if (!shuttingDown && code !== 0) {
    console.error(`Bright Video API exited unexpectedly (code ${code}); restarting...`);
    setTimeout(() => {
      api = start(process.execPath, ['server/index.mjs']);
      api.on('exit', handleApiExit);
    }, 1000);
    return;
  }
  if (code && !ui.killed) ui.kill('SIGTERM');
  process.exitCode = code ?? 0;
}

api.on('exit', handleApiExit);
ui.on('exit', (code) => {
  if (code && !api.killed) api.kill('SIGTERM');
});
