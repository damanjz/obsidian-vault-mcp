/**
 * In-memory, read-only index of an Obsidian vault.
 *
 * Security model:
 * - The vault root is resolved to its real path once at startup.
 * - The walker skips every dot-entry (.obsidian, .trash, .git, ...).
 * - Symlinks and junctions are resolved; anything whose real path is outside
 *   the vault root is ignored. Each file is re-checked against its real path
 *   immediately before it is read.
 * - Tool inputs never reach the filesystem: notes are looked up in the index,
 *   and user-supplied paths are rejected if they resolve outside the vault.
 * - Only read APIs are used (readdir, stat, realpath, readFile).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseNote, splitLines, type LinkRef } from "./markdown.js";

export interface Note {
  /** Vault-relative path with forward slashes, NFC-normalised, e.g. "Projects/Plan.md". */
  path: string;
  /** File name without the .md extension (what Obsidian shows and links by). */
  title: string;
  /** Vault-relative folder, "" for the root. */
  folder: string;
  mtimeMs: number;
  size: number;
  lines: string[];
  /** Lower-cased full text, used for fast case-insensitive matching. */
  lower: string;
  frontmatter: Record<string, unknown>;
  frontmatterError?: string;
  /** 0-based index of the first line after the frontmatter. */
  bodyStartLine: number;
  tags: string[];
  aliases: string[];
  links: LinkRef[];
}

export interface ResolvedTarget {
  kind: "note" | "attachment";
  path: string;
}

export interface VaultOptions {
  /** Minimum time between filesystem rescans, in ms. 0 rescans on every call. */
  refreshIntervalMs?: number;
  /** Notes larger than this many bytes are skipped. */
  maxNoteBytes?: number;
  /** Called with human-readable diagnostics (never written to stdout). */
  log?: (message: string) => void;
}

export interface RefreshStats {
  notes: number;
  attachments: number;
  reparsed: number;
  skipped: number;
  ms: number;
}

export class VaultError extends Error {
  constructor(
    message: string,
    readonly code: "OUTSIDE_VAULT" | "NOT_FOUND" | "INVALID_INPUT",
  ) {
    super(message);
    this.name = "VaultError";
  }
}

const DEFAULT_MAX_NOTE_BYTES = 5 * 1024 * 1024;

export class Vault {
  private notes = new Map<string, Note>();
  private attachments = new Map<string, string>(); // lower-case path -> path
  private attachmentsByName = new Map<string, string[]>(); // lower-case file name -> paths
  private byPath = new Map<string, string>(); // lower-case path without .md -> path
  private byTitle = new Map<string, string[]>(); // lower-case title -> paths
  private byAlias = new Map<string, string[]>(); // lower-case alias -> paths
  private resolved = new WeakMap<LinkRef, ResolvedTarget | null>();
  private lastRefresh = 0;
  private inflight: Promise<RefreshStats> | null = null;
  private lastStats: RefreshStats = { notes: 0, attachments: 0, reparsed: 0, skipped: 0, ms: 0 };
  private readonly refreshIntervalMs: number;
  private readonly maxNoteBytes: number;
  private readonly log: (message: string) => void;

  private constructor(
    readonly root: string,
    /** The vault path as given (resolved, not real-pathed), so absolute inputs using a symlinked spelling still work. */
    private readonly givenRoot: string,
    options: VaultOptions,
  ) {
    this.refreshIntervalMs = options.refreshIntervalMs ?? 2000;
    this.maxNoteBytes = options.maxNoteBytes ?? DEFAULT_MAX_NOTE_BYTES;
    this.log = options.log ?? (() => {});
  }

  /** Open a vault directory and build the initial index. */
  static async open(vaultPath: string, options: VaultOptions = {}): Promise<Vault> {
    if (!vaultPath || !vaultPath.trim()) throw new VaultError("No vault path given.", "INVALID_INPUT");
    let root: string;
    try {
      root = await fs.realpath(path.resolve(vaultPath));
    } catch {
      throw new VaultError(`Vault path does not exist: ${vaultPath}`, "NOT_FOUND");
    }
    const st = await fs.stat(root);
    if (!st.isDirectory()) throw new VaultError(`Vault path is not a directory: ${vaultPath}`, "INVALID_INPUT");
    const vault = new Vault(root, path.resolve(vaultPath), options);
    await vault.refresh(true);
    return vault;
  }

  get stats(): RefreshStats {
    return this.lastStats;
  }

  /** Rescan the vault, re-reading only files whose size or mtime changed. */
  async refresh(force = false): Promise<RefreshStats> {
    if (this.inflight) return this.inflight;
    if (!force && Date.now() - this.lastRefresh < this.refreshIntervalMs) return this.lastStats;
    this.inflight = this.scan().finally(() => {
      this.inflight = null;
      this.lastRefresh = Date.now();
    });
    return this.inflight;
  }

  allNotes(): Note[] {
    return [...this.notes.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  get noteCount(): number {
    return this.notes.size;
  }

  getNote(notePath: string): Note | undefined {
    return this.notes.get(notePath);
  }

  /**
   * Convert user input (vault-relative or absolute path) into a normalised
   * vault-relative path. Throws OUTSIDE_VAULT for anything that escapes the root.
   */
  toVaultPath(input: string): string {
    const raw = input.normalize("NFC").trim().replace(/\\/g, "/");
    if (raw.includes("\u0000")) throw new VaultError("Invalid path.", "INVALID_INPUT");
    let rel: string;
    if (path.isAbsolute(raw) || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
      // Absolute paths are accepted only when they point inside the vault.
      const abs = path.resolve(raw);
      rel = path.relative(this.root, abs);
      if (!relIsInside(rel)) rel = path.relative(this.givenRoot, abs);
    } else {
      rel = path.relative(this.root, path.resolve(this.root, raw));
    }
    if (!relIsInside(rel)) throw new VaultError(`Path is outside the vault: ${input}`, "OUTSIDE_VAULT");
    if (rel === "") return "";
    const posix = rel.split(path.sep).join("/");
    if (posix.split("/").some((seg) => seg.startsWith("."))) {
      throw new VaultError(`Hidden folders and files are not indexed: ${input}`, "OUTSIDE_VAULT");
    }
    return posix;
  }

  /**
   * Find a note by path ("Folder/Note.md", "Folder/Note"), title ("Note") or
   * frontmatter alias. Returns the best match plus any other candidates.
   */
  findNote(input: string): { note: Note; others: string[] } {
    if (!input || !input.trim()) throw new VaultError("Note path or title is required.", "INVALID_INPUT");
    const rel = this.toVaultPath(input);
    const key = stripMd(rel).toLowerCase();

    const exact = this.byPath.get(key);
    if (exact) return { note: this.notes.get(exact)!, others: [] };

    const candidates =
      (!key.includes("/") ? this.byTitle.get(key) : undefined) ??
      this.suffixMatches(key) ??
      this.byAlias.get(key) ??
      (key.includes("/") ? this.byAlias.get(key.slice(key.lastIndexOf("/") + 1)) : undefined);
    if (candidates && candidates.length) {
      const sorted = rankCandidates(candidates, "");
      return { note: this.notes.get(sorted[0]!)!, others: sorted.slice(1) };
    }
    const suggestions = this.suggest(key);
    throw new VaultError(
      `Note not found: ${input}` + (suggestions.length ? `. Did you mean: ${suggestions.join(", ")}?` : ""),
      "NOT_FOUND",
    );
  }

  /** Resolve a link target the way Obsidian does: exact path, then shortest-path title match. */
  resolveLink(link: LinkRef, sourcePath: string): ResolvedTarget | null {
    const cached = this.resolved.get(link);
    if (cached !== undefined) return cached;
    const result = this.resolveTarget(link.target, sourcePath, link.syntax === "markdown");
    this.resolved.set(link, result);
    return result;
  }

  resolveTarget(target: string, sourcePath: string, relativeFirst = false): ResolvedTarget | null {
    const t = target.normalize("NFC").trim().replace(/\\/g, "/");
    if (t === "") return { kind: "note", path: sourcePath };
    const sourceFolder = parentOf(sourcePath);
    const attempts: string[] = [];
    if (relativeFirst && !t.startsWith("/")) {
      const joined = path.posix.normalize(path.posix.join(sourceFolder, t));
      if (!joined.startsWith("..")) attempts.push(joined);
    }
    const fromRoot = path.posix.normalize(t.replace(/^\/+/, ""));
    if (fromRoot !== ".." && !fromRoot.startsWith("../")) attempts.push(fromRoot);
    if (attempts.length === 0) return null; // escapes the vault

    for (const p of attempts) {
      const hit = this.byPath.get(stripMd(p).toLowerCase());
      if (hit) return { kind: "note", path: hit };
    }
    const base = attempts[attempts.length - 1]!;
    const key = stripMd(base).toLowerCase();
    const candidates = key.includes("/") ? this.suffixMatches(key) : this.byTitle.get(key);
    if (candidates && candidates.length) return { kind: "note", path: rankCandidates(candidates, sourceFolder)[0]! };

    for (const p of attempts) {
      const att = this.attachments.get(p.toLowerCase());
      if (att) return { kind: "attachment", path: att };
    }
    const baseLower = base.toLowerCase();
    const byName = this.attachmentsByName.get(baseLower.slice(baseLower.lastIndexOf("/") + 1));
    if (byName && byName.length) {
      const matching = baseLower.includes("/") ? byName.filter((p) => p.toLowerCase().endsWith("/" + baseLower)) : byName;
      if (matching.length) return { kind: "attachment", path: rankCandidates(matching, sourceFolder)[0]! };
    }
    return null;
  }

  private suffixMatches(key: string): string[] | undefined {
    if (!key.includes("/")) return undefined;
    const out: string[] = [];
    for (const [k, p] of this.byPath) if (k.endsWith("/" + key)) out.push(p);
    return out.length ? out : undefined;
  }

  private suggest(key: string): string[] {
    const name = key.slice(key.lastIndexOf("/") + 1);
    if (!name) return [];
    const out: string[] = [];
    for (const note of this.notes.values()) {
      if (note.title.toLowerCase().includes(name)) out.push(note.path);
      if (out.length >= 5) break;
    }
    return out;
  }

  private async scan(): Promise<RefreshStats> {
    const started = performance.now();
    const found = new Map<string, { abs: string; mtimeMs: number; size: number }>();
    const attachments: string[] = [];
    let skipped = 0;
    const visited = new Set<string>();

    const walk = async (absDir: string, relDir: string): Promise<void> => {
      let real: string;
      try {
        real = await fs.realpath(absDir);
      } catch {
        return;
      }
      if (!isInside(this.root, real) || visited.has(real)) return;
      visited.add(real);
      let entries;
      try {
        entries = await fs.readdir(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      await Promise.all(
        entries.map(async (entry) => {
          if (entry.name.startsWith(".")) return;
          const abs = path.join(absDir, entry.name);
          const rel = (relDir ? `${relDir}/${entry.name}` : entry.name).normalize("NFC");
          let isDir = entry.isDirectory();
          let isFile = entry.isFile();
          if (entry.isSymbolicLink()) {
            try {
              const target = await fs.realpath(abs);
              if (!isInside(this.root, target)) return;
              const st = await fs.stat(target);
              isDir = st.isDirectory();
              isFile = st.isFile();
            } catch {
              return;
            }
          }
          if (isDir) return walk(abs, rel);
          if (!isFile) return;
          if (/\.md$/i.test(entry.name)) {
            try {
              const st = await fs.stat(abs);
              if (st.size > this.maxNoteBytes) {
                skipped++;
                this.log(`Skipping ${rel}: ${st.size} bytes exceeds the ${this.maxNoteBytes} byte limit`);
                return;
              }
              found.set(rel, { abs, mtimeMs: st.mtimeMs, size: st.size });
            } catch {
              skipped++;
            }
          } else {
            attachments.push(rel);
          }
        }),
      );
    };
    await walk(this.root, "");

    const next = new Map<string, Note>();
    let reparsed = 0;
    await Promise.all(
      [...found].map(async ([rel, info]) => {
        const prev = this.notes.get(rel);
        if (prev && prev.mtimeMs === info.mtimeMs && prev.size === info.size) {
          next.set(rel, prev);
          return;
        }
        const note = await this.readNote(rel, info.abs, info.mtimeMs, info.size);
        if (note) {
          next.set(rel, note);
          reparsed++;
        } else skipped++;
      }),
    );

    const changed =
      reparsed > 0 ||
      next.size !== this.notes.size ||
      attachments.length !== this.attachments.size ||
      attachments.some((a) => !this.attachments.has(a.toLowerCase()));
    this.notes = next;
    if (changed) this.rebuildLookups(attachments);

    this.lastStats = {
      notes: next.size,
      attachments: attachments.length,
      reparsed,
      skipped,
      ms: Math.round(performance.now() - started),
    };
    return this.lastStats;
  }

  private async readNote(rel: string, abs: string, mtimeMs: number, size: number): Promise<Note | null> {
    try {
      // Re-check the real path right before reading, in case the entry was swapped for a link.
      const real = await fs.realpath(abs);
      if (!isInside(this.root, real)) return null;
      const text = (await fs.readFile(real, "utf8")).replace(/^\uFEFF/, "").normalize("NFC");
      const lines = splitLines(text);
      const parsed = parseNote(lines);
      const slash = rel.lastIndexOf("/");
      return {
        path: rel,
        title: stripMd(rel.slice(slash + 1)),
        folder: slash >= 0 ? rel.slice(0, slash) : "",
        mtimeMs,
        size,
        lines,
        lower: text.toLowerCase(),
        ...parsed,
      };
    } catch (err) {
      this.log(`Could not read ${rel}: ${(err as Error).message}`);
      return null;
    }
  }

  private rebuildLookups(attachments: string[]): void {
    this.byPath.clear();
    this.byTitle.clear();
    this.byAlias.clear();
    this.attachments.clear();
    this.attachmentsByName.clear();
    this.resolved = new WeakMap();
    for (const note of this.notes.values()) {
      this.byPath.set(stripMd(note.path).toLowerCase(), note.path);
      push(this.byTitle, note.title.toLowerCase(), note.path);
      for (const alias of note.aliases) push(this.byAlias, alias.toLowerCase(), note.path);
    }
    for (const rel of attachments) {
      this.attachments.set(rel.toLowerCase(), rel);
      push(this.attachmentsByName, rel.slice(rel.lastIndexOf("/") + 1).toLowerCase(), rel);
    }
  }
}

export function stripMd(p: string): string {
  return p.replace(/\.md$/i, "");
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Prefer a candidate in the source's own folder, then the shortest path, then alphabetical. */
function rankCandidates(paths: string[], sourceFolder: string): string[] {
  return [...paths].sort((a, b) => {
    const sa = parentOf(a) === sourceFolder ? 0 : 1;
    const sb = parentOf(b) === sourceFolder ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const da = a.split("/").length;
    const db = b.split("/").length;
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });
}

export function isInside(root: string, candidate: string): boolean {
  return relIsInside(path.relative(root, candidate));
}

function relIsInside(rel: string): boolean {
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !rel.startsWith("../") && !path.isAbsolute(rel);
}
