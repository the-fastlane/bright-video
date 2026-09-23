# BrightVideo

BrightVideo is a local video library for browsing, searching, filtering, and organizing personal videos. It runs on a Mac with Apple Silicon and is used through a standard web browser. Video files can be stored in a local folder or on a NAS share mounted on the Mac, including a Synology share.

The Mac is the application host. BrightVideo is not intended to be installed or run on the NAS itself. Apple Silicon is the supported architecture because thumbnail generation uses FFmpeg and VideoToolbox hardware acceleration on macOS.

## Features

- Timeline browsing by capture date
- Search and filtering by video metadata
- Albums for organizing videos
- Browser-based video previews and playback
- Support for common video formats including MP4, MOV, M4V, WebM, AVI, and MKV
- Supplemental metadata sidecar files
- Automatic library watching and manual rescanning
- SQLite catalog stored separately from the media library
- WebP thumbnails generated locally on the Mac
- Optional local AI visual keywords for searching objects, scenes, colors, and activities

## Requirements

- macOS on a Mac with an Apple Silicon chip (M1, M2, M3, M4, or newer)
- Node.js `22.22.3` or newer
- A local video folder or a NAS share mounted in macOS
- Optional: Ollama with the `moondream` vision model for AI visual keywords

The NAS is only a media source. The application, SQLite catalog, generated thumbnails, and Node.js runtime stay on the Mac for better CPU, memory, and media-processing performance.

## First-time setup

Clone the repository, install dependencies, and create the local configuration file:

```bash
npm install
cp .env.example .env
```

For a local library, set these values in `.env`:

```dotenv
VIDEO_SOURCE=local
VIDEO_ROOT=/Users/your-name/Movies/Videos
DATABASE_PATH=./data/bright-video.db
PORT=4318
```

For a NAS library, mount the share in macOS first and point BrightVideo at the mounted folder:

```dotenv
VIDEO_SOURCE=nas
NAS_VIDEO_ROOT=/Volumes/video-nfs
DATABASE_PATH=./data/bright-video-nas.db
PORT=4318
```

The application reads and streams files from the mounted share; it does not install anything on or run any application process on the NAS.

## Production mode

Build the optimized Angular browser bundle and start the production Node server with:

```bash
npm run start:production
```

This command builds the production bundle, prepares the optional NAS mount, and starts one Node process that serves both the browser application and the API. Keep this terminal open while using BrightVideo, or run the command under a macOS process manager if you want it to start automatically.

Open the application at:

```text
http://localhost:4318/
```

The port comes from `PORT` in `.env`. Confirm that the server is healthy with:

```bash
curl http://localhost:4318/api/health
```

For the best performance, keep `DATABASE_PATH` and `THUMBNAIL_ROOT` on the Mac's local storage even when the videos are on a NAS. Do not use `npm start` for normal use; it starts the Angular development server and is intended for development only.

BrightVideo does not scan the library automatically on startup. Use **Scan** in the header to index new or changed files. Use **Reindex** when metadata parsing rules change or you need to rebuild the full catalog.

## Optional AI visual keywords

BrightVideo can analyze generated thumbnails with the local Ollama `moondream`
vision model and store the resulting descriptions as searchable keywords. The
images and results stay on the Mac; this feature does not send thumbnails to a
hosted AI service. AI processing is off by default and is separate from the
normal library scan.

To enable it:

1. Install Ollama for macOS from [ollama.com](https://ollama.com/download/mac).
2. Pull the vision model once:

   ```bash
   ollama pull moondream
   ```

3. Start BrightVideo and run **Scan** so the library has generated thumbnails.
4. Open **Settings**, enable **AI Visual Search Keywords**, and leave the app
   running while the background analysis completes.

BrightVideo checks the local Ollama service when AI processing starts. If the
service is not already running, it attempts to start `ollama serve` itself.
The `moondream` model must still be installed. AI processing can be paused by
turning the setting off and resumed later. **Reset AI analysis** clears the
stored visual keywords and analysis results; it does not delete videos or
thumbnails. Enable AI again after resetting to analyze the thumbnails again.

AI analysis requires the Python executable configured by `AI_PYTHON`. The
default is `~/.venvs/bright-video-mlx/bin/python`; set `AI_PYTHON` to another
Python 3 executable if that path does not exist. The worker uses macOS `sips`
when Pillow is unavailable, so no Python package is required for the default
setup.

## Supplemental metadata

BrightVideo reads metadata from files ending in:

```text
.supplemental-metadata.json
```

For example:

```text
family-trip.mp4
family-trip.mp4.supplemental-metadata.json
```

The application also reads media metadata through ExifTool. Files without supplemental metadata can still be indexed using filesystem timestamps and media metadata.

## Configuration

BrightVideo supports these environment variables:

| Variable                | Default                                | Purpose                                                       |
| ----------------------- | -------------------------------------- | ------------------------------------------------------------- |
| `PORT`                  | `3000`                                 | HTTP port                                                     |
| `VIDEO_ROOT`            | `./videos`                             | Local video library                                           |
| `VIDEO_SOURCE`          | `local`                                | Select `local` or `nas` media                                 |
| `NAS_VIDEO_ROOT`        | `/mnt/synology_nfs_share`              | Host-mounted NAS path                                         |
| `NAS_MOUNT_SOURCE`      |                                        | NFS server and export                                         |
| `NAS_MOUNT_PATH`        |                                        | Local NFS mount path                                          |
| `NAS_MOUNT_OPTIONS`     |                                        | Comma-separated NFS mount options                             |
| `NAS_MOUNT_TYPE`        | inferred (`nfs` or `smb`)              | NAS mount protocol                                            |
| `NAS_USERNAME`          |                                        | NAS account for SMB mounts                                    |
| `NFS_PASSWORD`          |                                        | Mac administrator password for automatic sudo mounts          |
| `NAS_PASSWORD`          |                                        | Compatibility alias for NFS; SMB account password in SMB mode |
| `SCAN_CONCURRENCY`      | `4`                                    | Concurrent metadata scan workers                              |
| `THUMBNAIL_CONCURRENCY` | `12` (local), `4` (NAS)                | Concurrent thumbnail encoding workers                         |
| `DATABASE_PATH`         | `./data/bright-video.db`               | SQLite catalog file                                           |
| `THUMBNAIL_ROOT`        | next to `DATABASE_PATH`                | Local directory for generated WebP thumbnails                 |
| `AI_PYTHON`             | `~/.venvs/bright-video-mlx/bin/python` | Python executable for optional AI analysis                    |
| `AI_MODEL`              | `moondream`                            | Ollama vision model used for optional AI analysis             |
| `OLLAMA_HOST`           | `http://localhost:11434`               | Ollama service URL                                            |

For a host-mounted Synology NFS share, mount the share on the machine running
BrightVideo first, then set `VIDEO_SOURCE=nas` and point `NAS_VIDEO_ROOT` at
that mount. The application reads and streams files from the mount directly;
it does not mount NFS itself. The existing `/videos/...` endpoint supports
HTTP byte ranges, so browser seeking and partial playback continue to work.

When `VIDEO_SOURCE=nas`, `npm start` and `npm run start:production` first unmount
`NAS_MOUNT_PATH` if it is already mounted, then mount `NAS_MOUNT_SOURCE` using `NAS_MOUNT_OPTIONS`.
macOS may prompt for your administrator password in the terminal unless
`NFS_PASSWORD` is configured. The API and
Angular development server start only after the mount succeeds. When
`VIDEO_SOURCE=local`, this mount step is skipped.

For SMB, set `NAS_MOUNT_TYPE=smb`, `NAS_USERNAME`, `NAS_PASSWORD`, and use an
SMB source such as `//synology.local/video`. The startup script passes the
password through a temporary protected macOS SMB credentials file rather than
putting it in the process arguments, then removes that file after mounting.
`NAS_PASSWORD` is not an NFS account password. For NFS, use `NFS_PASSWORD` for
the Mac administrator password used by `sudo`; the existing `NAS_PASSWORD` name
is retained as a compatibility alias.

`SCAN_CONCURRENCY` controls how many different video files can be indexed at
once. It can improve NFS catalog scan throughput, but it does not split one
video stream across multiple TCP connections. Single-file pNFS or NFS
multipathing requires support from both the Synology server and the macOS NFS
client and cannot be enabled by this Node application.

If you change `PORT`, use the matching port in the application URL and health check.

## Local development

Start the API and Angular development server when actively developing the application:

```bash
npm install
cp .env.example .env
npm start
```

Edit `.env` before starting if you want to use a NAS. Set `VIDEO_SOURCE=nas`,
uncomment and update the `NAS_MOUNT_*` values, and keep `NAS_VIDEO_ROOT` equal
to the local mount path.

Open:

```text
http://localhost:4317/
```

The development server proxies API and video requests to the Node server on port `4318`.

Create only the optimized production browser bundle with:

```bash
npm run build
```

Run unit tests with:

```bash
npm test
```
