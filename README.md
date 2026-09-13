# BrightVideo

BrightVideo is a self-hosted video library for browsing, searching, filtering, and organizing personal videos. It uses the filesystem as the media source and a lightweight SQLite database for indexed metadata and albums.

The application does not generate thumbnails or require a separate media-processing service. Video previews and playback are handled by the browser, keeping the server lightweight and responsive.

## Features

- Timeline browsing by capture date
- Search and filtering by video metadata
- Albums for organizing videos
- Browser-based video previews and playback
- Support for common video formats including MP4, MOV, M4V, WebM, AVI, and MKV
- Supplemental metadata sidecar files
- Automatic library watching and manual rescanning
- SQLite catalog stored separately from the media library
- Docker deployment for NAS and home-server environments

## Docker deployment

The published container image is:

```text
ghcr.io/the-fastlane/bright-video:latest
```

The container serves the web application and API internally on port `3000`. The Compose example publishes it on host port `8420` to reduce conflicts with other applications. Mount your video library at `/data/videos` and the persistent catalog directory at `/data/catalog`.

### Docker Compose

Create a directory for the application and persistent data:

```text
bright-video/
  docker-compose.yml
  videos/
  catalog/
```

Create `docker-compose.yml` with:

```yaml
services:
  bright-video:
    image: ghcr.io/the-fastlane/bright-video:latest
    container_name: bright-video
    restart: unless-stopped
    ports:
      - '8420:3000'
    environment:
      PORT: 3000
      VIDEO_ROOT: /data/videos
      DATABASE_PATH: /data/catalog/bright-video.db
    volumes:
      - ./videos:/data/videos:ro
      - ./catalog:/data/catalog
```

Place video files and their `.supplemental-metadata.json` files in `videos/`, then start the application:

```bash
mkdir -p videos catalog
docker compose pull
docker compose up -d
```

Open the application at:

```text
http://localhost:8420/
```

For a NAS, replace `localhost` with the NAS IP address. For example:

```text
http://192.168.1.25:8420/
```

BrightVideo does not scan the library automatically on startup. Use **Scan** in the header to index only new or changed files. Use **Reindex** when metadata parsing rules change or you need to rebuild the full catalog; a full reindex may take some time for a large library. Check the service health with:

```bash
curl http://localhost:8420/api/health
```

### Synology Container Manager

Create a project directory on the Synology, for example:

```text
/volume1/docker/bright-video/
  docker-compose.yml
  videos/
  catalog/
```

Copy the Compose configuration above into that directory and copy your videos into `videos/`. Start the project from Container Manager or from an SSH session:

```bash
cd /volume1/docker/bright-video
docker compose pull
docker compose up -d
```

Then open `http://<synology-ip>:8420/` in a browser.

The media directory is mounted read-only by default. This prevents the application from modifying the source library. The catalog directory must remain writable so SQLite can store the index, albums, and metadata cache.

## Updating

Pull the latest image and recreate the container:

```bash
docker compose pull
docker compose up -d
```

Do not delete the `catalog/` directory during an update. It contains the indexed metadata and album assignments. Your video files remain in the separately mounted `videos/` directory.

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

The container supports these environment variables:

| Variable            | Default                         | Purpose                           |
| ------------------- | ------------------------------- | --------------------------------- |
| `PORT`              | `3000`                          | HTTP port inside the container    |
| `VIDEO_ROOT`        | `/data/videos`                  | Mounted video library             |
| `VIDEO_SOURCE`      | `local`                         | Select `local` or `nas` media     |
| `NAS_VIDEO_ROOT`    | `/mnt/synology_nfs_share`       | Host-mounted Synology NFS path    |
| `NAS_MOUNT_SOURCE`  |                                 | NFS server and export             |
| `NAS_MOUNT_PATH`    |                                 | Local NFS mount path              |
| `NAS_MOUNT_OPTIONS` |                                 | Comma-separated NFS mount options |
| `SCAN_CONCURRENCY`  | `4`                             | Concurrent metadata scan workers  |
| `DATABASE_PATH`     | `/data/catalog/bright-video.db` | SQLite catalog file               |

For a host-mounted Synology NFS share, mount the share on the machine running
BrightVideo first, then set `VIDEO_SOURCE=nas` and point `NAS_VIDEO_ROOT` at
that mount. The application reads and streams files from the mount directly;
it does not mount NFS itself. The existing `/videos/...` endpoint supports
HTTP byte ranges, so browser seeking and partial playback continue to work.

When `VIDEO_SOURCE=nas`, `npm start` first unmounts `NAS_MOUNT_PATH` if it is
already mounted, then mounts `NAS_MOUNT_SOURCE` using `NAS_MOUNT_OPTIONS`.
macOS may prompt for your administrator password in the terminal. The API and
Angular development server start only after the mount succeeds. When
`VIDEO_SOURCE=local`, this mount step is skipped.

`SCAN_CONCURRENCY` controls how many different video files can be indexed at
once. It can improve NFS catalog scan throughput, but it does not split one
video stream across multiple TCP connections. Single-file pNFS or NFS
multipathing requires support from both the Synology server and the macOS NFS
client and cannot be enabled by this Node application.

If you change the internal `PORT`, update the container port mapping and application URL accordingly.

## Local development

BrightVideo requires Node.js `22.22.3` or newer.

Install dependencies and start the API and Angular development server:

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

Create a production build with:

```bash
npm run build
```

Run unit tests with:

```bash
npm test
```
