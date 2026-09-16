import { spawn } from 'node:child_process';

const children = [];
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

const api = start(process.execPath, ['server/index.mjs']);
const uiEnvironment = { ...baseEnv };
delete uiEnvironment.PORT;
const ui = spawn('npm', ['run', 'start:ui', '--', '--port', uiEnvironment.UI_PORT ?? '4317'], {
  stdio: 'inherit',
  env: uiEnvironment,
});
children.push(ui);

function stop() {
  for (const child of children) child.kill('SIGTERM');
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

api.on('exit', (code) => {
  if (code && !ui.killed) ui.kill('SIGTERM');
  process.exitCode = code ?? 0;
});
ui.on('exit', (code) => {
  if (code && !api.killed) api.kill('SIGTERM');
});
