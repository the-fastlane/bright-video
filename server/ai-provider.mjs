import { promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseModelResult(content) {
  const normalized = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const jsonStart = normalized.indexOf('{');
  const jsonEnd = normalized.indexOf('}', jsonStart);
  if (jsonStart < 0 || jsonEnd < jsonStart) throw new Error('MLX returned no JSON metadata');
  const parsed = JSON.parse(normalized.slice(jsonStart, jsonEnd + 1));
  if (!parsed || typeof parsed !== 'object')
    throw new Error('AI provider returned an invalid result');
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags
        .filter((tag) => typeof tag === 'string')
        .map((tag) => tag.trim())
        .filter(Boolean)
    : [];
  if (!summary && !tags.length) throw new Error('AI provider returned no searchable metadata');
  return { summary, tags: [...new Set(tags)] };
}

export class LocalVisionProvider {
  #python;
  #model;
  #worker;
  #workerReady;
  #nextRequestId = 1;
  #pending = new Map();
  #stderr = '';

  constructor({ python = 'python3', model = '' } = {}) {
    this.#python = python;
    this.#model = model.trim();
  }

  async #startWorker() {
    if (this.#workerReady) return this.#workerReady;
    this.#workerReady = new Promise((resolve, reject) => {
      const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mlx-worker.py');
      const child = spawn(this.#python, [workerPath, this.#model], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.#worker = child;
      const output = createInterface({ input: child.stdout });
      output.on('line', (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.type === 'ready') return resolve();
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (!message.ok) return pending.reject(new Error(message.error || 'MLX worker request failed'));
        try {
          pending.resolve(parseModelResult(message.text ?? ''));
        } catch (error) {
          pending.reject(error);
        }
      });
      child.stderr.on('data', (chunk) => {
        this.#stderr += chunk.toString();
        if (this.#stderr.length > 8_000) this.#stderr = this.#stderr.slice(-8_000);
      });
      const fail = (error) => {
        const message = error instanceof Error ? error : new Error(String(error));
        if (this.#workerReady) this.#workerReady = undefined;
        for (const pending of this.#pending.values()) pending.reject(message);
        this.#pending.clear();
        this.#worker = undefined;
        reject(new Error(this.#stderr.trim() || message.message));
      };
      child.once('error', fail);
      child.once('exit', (code, signal) => {
        if (code !== 0 || this.#pending.size) {
          fail(new Error(`MLX worker exited with ${signal || `code ${code}`}`));
        }
      });
    });
    return this.#workerReady;
  }

  async analyzeThumbnail(thumbnailPath) {
    if (!this.#model) throw new Error('AI_MODEL must point to a local MLX model');
    await fs.access(thumbnailPath);
    await this.#startWorker();
    const id = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('MLX worker request timed out after 120s'));
      }, 120_000);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#worker.stdin.write(`${JSON.stringify({ id, image: thumbnailPath })}\n`);
    });
  }

  close() {
    for (const pending of this.#pending.values()) pending.reject(new Error('MLX worker stopped'));
    this.#pending.clear();
    this.#worker?.kill('SIGTERM');
    this.#worker = undefined;
    this.#workerReady = undefined;
  }

  describe() {
    return { provider: 'mlx-vlm', model: this.#model || null };
  }
}
