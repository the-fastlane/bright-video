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

## Requirements

- macOS on a Mac with an Apple Silicon chip (M1, M2, M3, M4, or newer)
- Node.js `22.22.3` or newer
- A local video folder or a NAS share mounted in macOS

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

| Variable                | Default                   | Purpose                                       |
| ----------------------- | ------------------------- | --------------------------------------------- |
| `PORT`                  | `3000`                    | HTTP port                                     |
| `VIDEO_ROOT`            | `./videos`                | Local video library                           |
| `VIDEO_SOURCE`          | `local`                   | Select `local` or `nas` media                 |
| `NAS_VIDEO_ROOT`        | `/mnt/synology_nfs_share` | Host-mounted NAS path                         |
| `NAS_MOUNT_SOURCE`      |                           | NFS server and export                         |
| `NAS_MOUNT_PATH`        |                           | Local NFS mount path                          |
| `NAS_MOUNT_OPTIONS`     |                           | Comma-separated NFS mount options             |
| `SCAN_CONCURRENCY`      | `4`                       | Concurrent metadata scan workers              |
| `THUMBNAIL_CONCURRENCY` | `12` (local), `4` (NAS)   | Concurrent thumbnail encoding workers         |
| `DATABASE_PATH`         | `./data/bright-video.db`  | SQLite catalog file                           |
| `THUMBNAIL_ROOT`        | next to `DATABASE_PATH`   | Local directory for generated WebP thumbnails |

For a host-mounted Synology NFS share, mount the share on the machine running
BrightVideo first, then set `VIDEO_SOURCE=nas` and point `NAS_VIDEO_ROOT` at
that mount. The application reads and streams files from the mount directly;
it does not mount NFS itself. The existing `/videos/...` endpoint supports
HTTP byte ranges, so browser seeking and partial playback continue to work.

When `VIDEO_SOURCE=nas`, `npm start` and `npm run start:production` first unmount
`NAS_MOUNT_PATH` if it is already mounted, then mount `NAS_MOUNT_SOURCE` using `NAS_MOUNT_OPTIONS`.
macOS may prompt for your administrator password in the terminal. The API and
Angular development server start only after the mount succeeds. When
`VIDEO_SOURCE=local`, this mount step is skipped.

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
