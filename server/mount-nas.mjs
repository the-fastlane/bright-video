import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if ((process.env.VIDEO_SOURCE ?? 'local').trim().toLowerCase() !== 'nas') process.exit(0);

const mountCommand = process.platform === 'darwin' ? 'mount_nfs' : 'mount';
const source = process.env.NAS_MOUNT_SOURCE;
const mountPath = process.env.NAS_MOUNT_PATH ?? process.env.NAS_VIDEO_ROOT;
const options = process.env.NAS_MOUNT_OPTIONS;

if (!source || !mountPath || !options) {
  throw new Error('NAS mode requires NAS_MOUNT_SOURCE, NAS_MOUNT_PATH, and NAS_MOUNT_OPTIONS');
}

console.log(`Preparing NAS mount at ${mountPath}`);
execFileSync('sudo', ['mkdir', '-p', mountPath], { stdio: 'inherit' });
try {
  execFileSync('sudo', ['umount', mountPath], { stdio: 'inherit' });
} catch {
  // The path is normally not mounted yet; continue to the mount command.
}

const mountArgs =
  mountCommand === 'mount_nfs'
    ? ['-o', options, source, mountPath]
    : ['-t', 'nfs', '-o', options, source, mountPath];
execFileSync('sudo', [mountCommand, ...mountArgs], {
  stdio: 'inherit',
});

if (!existsSync(mountPath)) throw new Error(`NAS mount path is not readable: ${mountPath}`);
console.log(`NAS mounted at ${mountPath}`);
