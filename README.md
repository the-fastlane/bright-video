# BrightVideo

BrightVideo is a self-hosted video library for browsing a folder of video files, reading their metadata, searching the catalog, and organizing videos into albums.

## Recommended deployment

The published image is hosted in GitHub Container Registry (GHCR):

```text
ghcr.io/<github-user>/bright-video:latest
```

The container serves both the Angular web app and the Node API on port `3000`. Video files are mounted read-only from the Synology share. The catalog database is stored separately so rescans and albums survive image updates.

## Create the GitHub repository

1. Create an empty public or private repository on GitHub named `bright-video`. Do not add a README, `.gitignore`, or license because this project already has those files.
2. From this project directory, set the repository URL and push the first version:

```bash
git init
git add .
git commit -m "Prepare BrightVideo for container deployment"
git branch -M main
git remote add origin https://github.com/<github-user>/bright-video.git
git push -u origin main
```

The workflow in `.github/workflows/publish-image.yml` then builds and publishes:

```text
ghcr.io/<github-user>/bright-video:latest
```

GitHub automatically provides the workflow token needed to publish to GHCR. No Docker Hub account or separate registry secret is required.

## Version a release

Update the version in `package.json`, commit it, and create a matching Git tag. A tag beginning with `v` publishes a versioned image as well as the immutable commit tag:

```bash
npm version patch
git push origin main --follow-tags
```

For example, version `0.1.1` publishes:

```text
ghcr.io/<github-user>/bright-video:latest
ghcr.io/<github-user>/bright-video:0.1.1
ghcr.io/<github-user>/bright-video:sha-...
```

Use a version tag in production when you want upgrades to be deliberate. Use `latest` when you want the Synology deployment to follow the default branch image.

## Synology Container Manager

The following layout keeps the catalog and media on persistent storage. Choose any shared folder; `/volume1/docker/bright-video` is used here as an example:

```text
/volume1/docker/bright-video/
	docker-compose.yml
	videos/
	catalog/
```

Copy `docker-compose.yml` from this repository into that folder. Replace `<github-user>` in the image name with the GitHub account or organization that owns the repository. Copy or move the video files and their `.supplemental-metadata.json` files into `videos/`.

If the GitHub package is private, sign in to GHCR from Container Manager first. A GitHub classic personal access token with `read:packages` is sufficient for pulling the image:

```bash
docker login ghcr.io -u <github-user>
```

Start the stack from the Synology project directory:

```bash
mkdir -p /volume1/docker/bright-video/videos /volume1/docker/bright-video/catalog
cd /volume1/docker/bright-video
docker compose pull
docker compose up -d
```

Open `http://<synology-ip>:3000/`. The initial scan can take time for a large library. Check health with:

```bash
curl http://<synology-ip>:3000/api/health
```

After adding or removing files, use the rescan control in BrightVideo. The watcher also notices changes in the mounted media folder.

## Updating the Synology deployment

For a versioned release, set the image in `docker-compose.yml` to the release tag, for example `ghcr.io/<github-user>/bright-video:0.1.1`. Then run:

```bash
cd /volume1/docker/bright-video
docker compose pull
docker compose up -d
```

Do not delete the `catalog/` directory during an update. It contains the SQLite database with album assignments and the indexed metadata cache. The media directory is mounted read-only by design; BrightVideo may create missing sidecar metadata beside a file only when the media mount is changed from `:ro` to `:rw`.

## Local development

BrightVideo requires Node.js `22.22.3` or newer:

```bash
npm install
npm start
```

Open `http://localhost:4200/`. The Angular development server proxies `/api` and `/videos` to the Node API on port `3000`.

Run a production build with:

```bash
npm run build
```

Run unit tests with:

```bash
npm test
```

## Configuration

The container supports these environment variables:

| Variable        | Default                         | Purpose                        |
| --------------- | ------------------------------- | ------------------------------ |
| `PORT`          | `3000`                          | HTTP port inside the container |
| `VIDEO_ROOT`    | `/data/videos`                  | Mounted video library          |
| `DATABASE_PATH` | `/data/catalog/bright-video.db` | SQLite catalog file            |

The public container port can be changed in `docker-compose.yml`, but the internal application port should remain `3000` unless `PORT` is changed too.
