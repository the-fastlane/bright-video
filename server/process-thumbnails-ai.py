#!/usr/bin/env python3
"""
High-performance batch processing script for thumbnail AI keyword generation.
Uses Ollama's local Moondream vision model on Apple Silicon M3 GPU.
"""

import argparse
import base64
import html
import io
import json
import os
import re
import signal
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    Image = None

# Graceful termination handling
running = True

def handle_signal(signum, frame):
    global running
    sys.stderr.write(f"\nReceived signal {signum}, stopping gracefully after current item...\n")
    running = False

signal.signal(signal.SIGINT, handle_signal)
signal.signal(signal.SIGTERM, handle_signal)

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def ensure_schema(conn: sqlite3.Connection):
    """Ensure videos and video_analysis tables have required columns."""
    cursor = conn.cursor()
    cursor.execute("PRAGMA table_info(videos)")
    video_cols = {row[1] for row in cursor.fetchall()}
    if "keywords" not in video_cols:
        cursor.execute("ALTER TABLE videos ADD COLUMN keywords TEXT NOT NULL DEFAULT ''")

    cursor.execute("PRAGMA table_info(video_analysis)")
    analysis_cols = {row[1] for row in cursor.fetchall()}
    if "retry_count" not in analysis_cols:
        cursor.execute("ALTER TABLE video_analysis ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0")

    cursor.execute("PRAGMA table_info(video_search)")
    search_cols = {row[1] for row in cursor.fetchall()}
    if "keywords" not in search_cols and search_cols:
        cursor.execute("ALTER TABLE video_search RENAME TO video_search_legacy")
        cursor.execute("""
            CREATE VIRTUAL TABLE video_search USING fts5(
                video_id UNINDEXED,
                title,
                description,
                summary,
                tags,
                people,
                location,
                keywords
            )
        """)
        cursor.execute("""
            INSERT INTO video_search (video_id, title, description, summary, tags, people, location, keywords)
            SELECT legacy.video_id, legacy.title, legacy.description, legacy.summary, legacy.tags,
                   legacy.people, legacy.location, COALESCE(videos.keywords, '')
            FROM video_search_legacy AS legacy
            LEFT JOIN videos ON videos.id = legacy.video_id
        """)
        cursor.execute("DROP TABLE video_search_legacy")
    conn.commit()

def load_image_b64(file_path: Path) -> str:
    """Reads image file and converts to base64 JPEG format for Ollama's vision runner."""
    if not file_path.exists():
        raise FileNotFoundError(f"Thumbnail not found: {file_path}")

    # If Pillow is available, convert image to standard RGB JPEG in memory
    # Resizing to Moondream's native 378px crop reduces payload size and decode latency.
    if Image is not None:
        try:
            with Image.open(file_path) as img:
                if img.mode not in ("RGB", "L"):
                    img = img.convert("RGB")
                # Downscale proportionally so max dimension is 378
                if img.width > 378 or img.height > 378:
                    img.thumbnail((378, 378), Image.Resampling.BILINEAR)
                buffer = io.BytesIO()
                img.save(buffer, format="JPEG", quality=80)
                return base64.b64encode(buffer.getvalue()).decode("utf-8")
        except Exception:
            pass

    # Fallback to macOS `sips` to ensure WebP/other formats are converted to JPEG
    try:
        import subprocess, tempfile
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        subprocess.run(
            ["sips", "-s", "format", "jpeg", "--resampleHeightWidthMax", "378", str(file_path), "--out", str(tmp_path)],
            check=True,
            capture_output=True,
        )
        with open(tmp_path, "rb") as f:
            data = base64.b64encode(f.read()).decode("utf-8")
        tmp_path.unlink(missing_ok=True)
        return data
    except Exception as error:
        raise ValueError(f"Invalid or unsupported thumbnail: {file_path.name}") from error

def clean_visual_description(response_text: str) -> str:
    """Normalize model output into clean, searchable visual descriptions and keywords."""
    cleaned = html.unescape(response_text).replace("\r", "\n")
    cleaned = re.sub(r"<[^>]*>", " ", cleaned)
    for prefix in (
        "description:",
        "visual description:",
        "keywords:",
        "tags:",
        "objects:",
    ):
        if cleaned.strip().lower().startswith(prefix):
            cleaned = cleaned.strip()[len(prefix) :].strip()

    # Remove hallucinated identifier numbers or bounding box coordinate arrays
    cleaned = re.sub(r"\[\s*\d+(?:\.\d+)?\s*(?:,\s*\d+(?:\.\d+)?\s*)*\]", "", cleaned)
    cleaned = re.sub(r"\b(?:ids?|confidence|score)\s*[:=]?\s*\(?\d+(?:\.\d+)?\)?", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\b(?:sa|id)[_-]\d+\b", "", cleaned, flags=re.IGNORECASE)

    # Clean stray brackets, quotes, and whitespace
    cleaned = cleaned.translate(str.maketrans({"[": "", "]": "", '"': ""}))
    cleaned = re.sub(r"^[^\w]+", "", cleaned, flags=re.UNICODE)
    cleaned = re.sub(r"\s+", " ", cleaned)
    cleaned = cleaned.strip(" ,.;:-()")

    # Filter out empty or placeholder words
    if cleaned.lower() in {"unspecified", "unknown", "none", "n/a", "na", ""}:
        return ""

    return cleaned

def call_ollama(ollama_url: str, model: str, b64_img: str, max_retries: int = 2) -> str:
    """Sends fast HTTP POST request to Ollama native API."""
    endpoint = f"{ollama_url.rstrip('/')}/api/generate"
    prompts = (
        "Describe the people, objects, and setting in this image using short keywords. "
        "Mention colors and actions when visible. For sports, identify the sport from its equipment.",
        "What is in this image? Describe the main visible subjects and setting.",
    )

    last_err = None
    for attempt in range(max_retries):
        try:
            payload = json.dumps({
                "model": model,
                "prompt": prompts[min(attempt, len(prompts) - 1)],
                "images": [b64_img],
                "stream": False,
                "keep_alive": -1,
                "options": {
                    "num_predict": 60,
                    "temperature": 0.1
                }
            }).encode("utf-8")
            req = urllib.request.Request(
                endpoint,
                data=payload,
                headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                response_text = data.get("response", "").strip()
                cleaned = clean_visual_description(response_text)
                if not cleaned:
                    raise RuntimeError("Ollama returned an empty visual description")
                return cleaned
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8", errors="replace").strip()
            except Exception:
                detail = ""
            last_err = RuntimeError(
                f"Ollama request failed ({e.code}): {detail or e.reason}"
            )
            if attempt < max_retries - 1:
                time.sleep(0.5)
        except Exception as e:
            last_err = e
            if attempt < max_retries - 1:
                time.sleep(0.5)

    raise last_err or RuntimeError("Ollama generation failed")

def process_batch(
    db_path: str,
    thumbnails_dir: str,
    ollama_url: str,
    model: str,
    limit: int = 0,
    report_json: bool = True
):
    conn = sqlite3.connect(db_path, timeout=60.0)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA temp_store = MEMORY")
    ensure_schema(conn)

    cursor = conn.cursor()

    # Get overall counts
    cursor.execute("SELECT COUNT(*) FROM videos")
    total_videos = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM videos WHERE keywords != '' AND keywords IS NOT NULL")
    already_processed = cursor.fetchone()[0]

    # Query records needing keywords (where keywords is empty and retry_count < 2)
    query = """
        SELECT v.id, v.thumbnail_path, v.filename, COALESCE(va.retry_count, 0)
        FROM videos v
        LEFT JOIN video_analysis va ON va.video_id = v.id
        WHERE (v.keywords IS NULL OR v.keywords = '')
          AND v.thumbnail_path IS NOT NULL
          AND v.thumbnail_path != ''
          AND COALESCE(va.retry_count, 0) < 2
        ORDER BY v.id ASC
    """
    if limit > 0:
        query += f" LIMIT {limit}"

    cursor.execute(query)
    records = cursor.fetchall()

    if report_json:
        print(json.dumps({
            "event": "started",
            "total_videos": total_videos,
            "already_processed": already_processed,
            "pending_in_batch": len(records),
            "model": model
        }), flush=True)

    processed_in_run = 0
    errors_in_run = 0
    t_start = time.time()

    thumbnails_path = Path(thumbnails_dir).resolve()

    for row in records:
        if not running:
            break

        video_id, thumbnail_rel, filename, retry_count = row
        thumb_file = thumbnails_path / thumbnail_rel

        item_start = time.time()
        try:
            b64_img = load_image_b64(thumb_file)
            keywords = call_ollama(ollama_url, model, b64_img, max_retries=2)

            # Update videos and FTS5 search table and video_analysis
            cursor.execute("UPDATE videos SET keywords = ? WHERE id = ?", (keywords, video_id))
            cursor.execute("DELETE FROM video_search WHERE video_id = ?", (video_id,))
            cursor.execute("""
                INSERT INTO video_search (video_id, title, description, summary, tags, people, location, keywords)
                SELECT id, title || ' ' || filename, description, '', '', people, location, keywords
                FROM videos WHERE id = ?
            """, (video_id,))
            cursor.execute("""
                INSERT INTO video_analysis (video_id, status, summary, provider, model, analyzed_at, error, retry_count)
                VALUES (?, 'completed', ?, 'ollama', ?, ?, NULL, 0)
                ON CONFLICT(video_id) DO UPDATE SET
                    status = 'completed',
                    summary = excluded.summary,
                    provider = excluded.provider,
                    model = excluded.model,
                    analyzed_at = excluded.analyzed_at,
                    error = NULL,
                    retry_count = 0
            """, (video_id, keywords, model, now_iso()))

            conn.commit()
            processed_in_run += 1
            elapsed = time.time() - item_start

            if report_json:
                print(json.dumps({
                    "event": "item_processed",
                    "video_id": video_id,
                    "filename": filename,
                    "keywords": keywords,
                    "processed": already_processed + processed_in_run,
                    "total": total_videos,
                    "duration_s": round(elapsed, 2)
                }), flush=True)

        except Exception as e:
            errors_in_run += 1
            err_msg = str(e)
            sys.stderr.write(f"Error processing video {video_id} ({filename}): {err_msg}\n")
            try:
                cursor.execute("""
                    INSERT INTO video_analysis (video_id, status, summary, provider, model, analyzed_at, error, retry_count)
                    VALUES (?, 'failed', '', 'ollama', ?, ?, ?, 1)
                    ON CONFLICT(video_id) DO UPDATE SET
                        status = 'failed',
                        analyzed_at = excluded.analyzed_at,
                        error = excluded.error,
                        retry_count = video_analysis.retry_count + 1
                """, (video_id, model, now_iso(), err_msg))
                conn.commit()
            except Exception as db_err:
                sys.stderr.write(f"Failed to record error in DB for {video_id}: {db_err}\n")

            if report_json:
                print(json.dumps({
                    "event": "item_error",
                    "video_id": video_id,
                    "filename": filename,
                    "error": err_msg,
                    "processed": already_processed + processed_in_run,
                    "total": total_videos
                }), flush=True)

    conn.close()

    total_time = time.time() - t_start
    if report_json:
        print(json.dumps({
            "event": "finished",
            "processed_in_run": processed_in_run,
            "errors_in_run": errors_in_run,
            "stopped": not running,
            "total_time_s": round(total_time, 2),
            "total_processed": already_processed + processed_in_run,
            "total_videos": total_videos
        }), flush=True)

def main():
    parser = argparse.ArgumentParser(description="Process video thumbnails with Ollama Moondream")
    parser.add_argument("--db", default=None, help="SQLite database path")
    parser.add_argument("--thumbnails-dir", default=None, help="Thumbnails directory")
    parser.add_argument("--ollama-url", default=None, help="Ollama server URL")
    parser.add_argument("--model", default=None, help="Model name")
    parser.add_argument("--limit", type=int, default=0, help="Max records to process (0 = all)")
    parser.add_argument("--single-pass", action="store_true", help="Run once through pending records and exit")
    args = parser.parse_args()

    # Load environment variables from .env if present
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if env_file.exists():
        with open(env_file, "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip()
                    if k and k not in os.environ:
                        os.environ[k] = v

    db_path = args.db or os.getenv("DATABASE_PATH", "./data/bright-video.db")
    thumbnails_dir = args.thumbnails_dir or os.getenv("THUMBNAIL_ROOT", "./data/thumbnails")
    ollama_url = args.ollama_url or os.getenv("OLLAMA_HOST", "http://localhost:11434")
    model = args.model or os.getenv("AI_MODEL", "moondream")

    process_batch(
        db_path=db_path,
        thumbnails_dir=thumbnails_dir,
        ollama_url=ollama_url,
        model=model,
        limit=args.limit
    )

if __name__ == "__main__":
    main()
