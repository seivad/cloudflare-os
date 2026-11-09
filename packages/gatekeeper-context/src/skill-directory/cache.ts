// Small in-isolate caches. Directory data is public and the same for every caller, so one isolate's
// callers share them; nothing here outlives the isolate.

/** Entries that expire `ttlMs` after they are set; the oldest are evicted past `maxEntries`. */
export class TtlCache<V> {
  #entries = new Map<string, { value: V; expires: number }>();

  constructor(private ttlMs: number, private maxEntries: number, private now: () => number) {}

  get(key: string): V | undefined {
    let entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.#entries.size > this.maxEntries) {
      this.#entries.delete(this.#entries.keys().next().value!);
    }
  }
}

/**
 * Compressed repository archives keyed by repository and commit, which never change: least recently
 * used entries are evicted once their total size exceeds `maxBytes`. Only archives fetched from a
 * repository confirmed public belong here.
 */
export class ArchiveCache {
  #entries = new Map<string, { chunks: Uint8Array[]; size: number }>();
  #size = 0;

  constructor(private maxBytes: number) {}

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  get(key: string): Uint8Array[] | undefined {
    let entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.chunks;
  }

  set(key: string, chunks: Uint8Array[], size: number): void {
    if (size > this.maxBytes) return;
    let existing = this.#entries.get(key);
    if (existing) {
      this.#entries.delete(key);
      this.#size -= existing.size;
    }
    this.#entries.set(key, { chunks, size });
    this.#size += size;
    for (let [oldest, entry] of this.#entries) {
      if (this.#size <= this.maxBytes) break;
      this.#entries.delete(oldest);
      this.#size -= entry.size;
    }
  }
}
