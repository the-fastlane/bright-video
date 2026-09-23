import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if ((process.env.VIDEO_SOURCE ?? 'local').trim().toLowerCase() !== 'nas') process.exit(0);

const source = process.env.NAS_MOUNT_SOURCE;
const mountPath = process.env.NAS_MOUNT_PATH ?? process.env.NAS_VIDEO_ROOT;
const options = process.env.NAS_MOUNT_OPTIONS;
const mountType = (process.env.NAS_MOUNT_TYPE ?? (source?.startsWith('//') ? 'smb' : 'nfs'))
  .trim()
  .toLowerCase();
const sudoPassword =
  process.env.NFS_PASSWORD ?? (mountType === 'nfs' ? process.env.NAS_PASSWORD : undefined);

if (!source || !mountPath || (mountType === 'nfs' && !options)) {
  throw new Error(
    'NAS mode requires NAS_MOUNT_SOURCE and NAS_MOUNT_PATH; NFS also requires NAS_MOUNT_OPTIONS',
  );
}
if (!['nfs', 'smb'].includes(mountType))
  throw new Error(`NAS_MOUNT_TYPE must be either "nfs" or "smb", received "${mountType}"`);

const mountCommand =
  mountType === 'smb' ? 'mount_smbfs' : process.platform === 'darwin' ? 'mount_nfs' : 'mount';

function assertSafeCredential(value, name) {
  if (value.includes('\n') || value.includes('\r'))
    throw new Error(`${name} must not contain newline characters`);
}

function sudo(args) {
  const sudoArgs = sudoPassword ? ['-S', '-p', '', ...args] : args;
  return execFileSync('sudo', sudoArgs, {
    input: sudoPassword ? `${sudoPassword}\n` : undefined,
    stdio: sudoPassword ? ['pipe', 'inherit', 'inherit'] : 'inherit',
  });
}

function mountSmb() {
  const username = process.env.NAS_USERNAME;
  const password = process.env.NAS_PASSWORD;
  if (!username || !password) throw new Error('SMB mode requires NAS_USERNAME and NAS_PASSWORD');
  assertSafeCredential(username, 'NAS_USERNAME');
  assertSafeCredential(password, 'NAS_PASSWORD');
  if (!source.startsWith('//')) throw new Error('SMB NAS_MOUNT_SOURCE must start with //');

  const credentialsHome = mkdtempSync(path.join(os.tmpdir(), 'bright-video-smb-'));
  const credentialsFile = path.join(credentialsHome, '.nsmbrc');
  writeFileSync(credentialsFile, `[default]\nusername=${username}\npassword=${password}\n`);
  chmodSync(credentialsFile, 0o600);
  try {
    const smbSource = `//${username}@${source.slice(2)}`;
    sudo(['env', `HOME=${credentialsHome}`, mountCommand, '-N', smbSource, mountPath]);
  } finally {
    rmSync(credentialsHome, { recursive: true, force: true });
  }
}

console.log(`Preparing NAS mount at ${mountPath}`);
try {
  sudo(['umount', mountPath]);
} catch {
  // The path is normally not mounted yet; continue to the mount command.
}
sudo(['mkdir', '-p', mountPath]);

if (mountType === 'smb') {
  mountSmb();
} else {
  const mountArgs =
    mountCommand === 'mount_nfs'
      ? ['-o', options, source, mountPath]
      : ['-t', 'nfs', '-o', options, source, mountPath];
  sudo([mountCommand, ...mountArgs]);
}

if (!existsSync(mountPath)) throw new Error(`NAS mount path is not readable: ${mountPath}`);
console.log(`NAS mounted at ${mountPath}`);
