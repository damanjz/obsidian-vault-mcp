/**
 * Tool implementations. Plain functions over a Vault that return JSON-ready
 * objects, so they can be tested without the MCP transport.
 */
import { Vault, VaultError, type Note } from "./vault.js";
import type { LinkRef } from "./markdown.js";

export const LIMITS = {
  searchDefault: 10,
  searchMax: 100,
  snippetsPerNote: 3,
  snippetChars: 200,
  readDefaultChars: 40_000,
  readMaxChars: 200_000,
  listDefault: 200,
  listMax: 2_000,
  linksDefault: 200,
  linksMax: 2_000,
} as const;

/* ------------------------------------------------------------------------- */
/* search                                                                    */
/* ------------------------------------------------------------------------- */

export interface SearchArgs {
  query: string;
  limit?: number;
  folder?: string;
  tag?: string;
}

export interface SearchMatch {
  line: number;
  text: string;
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  tags: string[];
  matches: SearchMatch[];
}

export function search(vault: Vault, args: SearchArgs) {
  const limit = clamp(args.limit ?? LIMITS.searchDefault, 1, LIMITS.searchMax);
  const { terms, tags } = parseQuery(args.query ?? "");
  if (args.tag) tags.push(normaliseTag(args.tag));
  if (terms.length === 0 && tags.length === 0) {
    throw new VaultError("Query is empty. Give at least one word, \"a phrase\" or #tag.", "INVALID_INPUT");
  }
  const folder = args.folder ? vault.toVaultPath(args.folder) : "";

  const pool = vault.allNotes().filter((n) => inFolder(n, folder) && tags.every((t) => hasTag(n, t)));

  // Term statistics for BM25 ranking.
  const N = Math.max(vault.noteCount, 1);
  const avgLen = vault.allNotes().reduce((s, n) => s + n.lower.length, 0) / N || 1;
  const perNote = pool.map((note) => {
    const titleLower = note.title.toLowerCase();
    const aliasLower = note.aliases.map((a) => a.toLowerCase());
    const pathLower = note.path.toLowerCase();
    const stats = terms.map((term) => ({
      tf: countOccurrences(note.lower, term, 100),
      inTitle: titleLower.includes(term),
      inAlias: aliasLower.some((a) => a.includes(term)),
      inPath: pathLower.includes(term),
    }));
    return { note, stats, titleLower, aliasLower };
  });
  const matching = perNote.filter((p) => p.stats.every((s) => s.tf > 0 || s.inTitle || s.inAlias || s.inPath));

  const df = terms.map((_, i) => matching.filter((p) => (p.stats[i]?.tf ?? 0) > 0).length);
  const k1 = 1.2;
  const b = 0.75;
  const fullQuery = terms.join(" ");

  const hits: SearchHit[] = matching.map(({ note, stats, titleLower, aliasLower }) => {
    let score = 0;
    stats.forEach((s, i) => {
      const idf = Math.log(1 + (N - (df[i] ?? 0) + 0.5) / ((df[i] ?? 0) + 0.5));
      const norm = s.tf + k1 * (1 - b + (b * note.lower.length) / avgLen);
      score += idf * ((s.tf * (k1 + 1)) / (norm || 1));
      if (s.inTitle) score += 2 * idf;
      if (s.inAlias) score += 1 * idf;
      else if (s.inPath && !s.inTitle) score += 0.5 * idf;
    });
    if (terms.length > 0 && (titleLower === fullQuery || aliasLower.includes(fullQuery))) score += 10;
    if (terms.length > 1 && note.lower.includes(fullQuery)) score += 2;
    return {
      path: note.path,
      title: note.title,
      score: Math.round(score * 1000) / 1000,
      tags: note.tags,
      matches: snippets(note, terms, tags),
    };
  });

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { query: args.query, terms, tags, total: hits.length, results: hits.slice(0, limit) };
}

/** Split a query into lower-cased terms ("quoted phrases" stay whole) and #tags. */
export function parseQuery(query: string): { terms: string[]; tags: string[] } {
  const terms: string[] = [];
  const tags: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query.normalize("NFC"))) !== null) {
    if (m[1] !== undefined) {
      const phrase = m[1].trim().toLowerCase().replace(/\s+/g, " ");
      if (phrase) terms.push(phrase);
    } else if (m[2] && m[2].startsWith("#") && m[2].length > 1) {
      tags.push(normaliseTag(m[2]));
    } else if (m[2]) {
      terms.push(m[2].toLowerCase());
    }
  }
  return { terms: [...new Set(terms)], tags: [...new Set(tags)] };
}

function snippets(note: Note, terms: string[], tags: string[]): SearchMatch[] {
  const needles = terms.length ? terms : tags.map((t) => "#" + t);
  const scored: { line: number; hits: number; text: string }[] = [];
  for (let i = 0; i < note.lines.length; i++) {
    const line = note.lines[i] ?? "";
    const lower = line.toLowerCase();
    let hits = 0;
    let first = -1;
    for (const n of needles) {
      const idx = lower.indexOf(n);
      if (idx >= 0) {
        hits++;
        if (first < 0 || idx < first) first = idx;
      }
    }
    if (hits > 0) scored.push({ line: i + 1, hits, text: excerpt(line, lower.length === line.length ? first : 0) });
  }
  return scored
    .sort((a, b) => b.hits - a.hits || a.line - b.line)
    .slice(0, LIMITS.snippetsPerNote)
    .sort((a, b) => a.line - b.line)
    .map(({ line, text }) => ({ line, text }));
}

function excerpt(line: string, at: number): string {
  const text = line.trim();
  const max = LIMITS.snippetChars;
  if (text.length <= max) return text;
  const lead = line.length - line.trimStart().length;
  let start = Math.max(0, at - lead - Math.floor(max / 3));
  start = Math.min(start, text.length - max);
  if (isLowSurrogate(text.charCodeAt(start))) start++;
  let end = start + max;
  if (isHighSurrogate(text.charCodeAt(end - 1))) end--;
  return (start > 0 ? "..." : "") + text.slice(start, end) + (end < text.length ? "..." : "");
}

function countOccurrences(hay: string, needle: string, cap: number): number {
  let count = 0;
  let idx = hay.indexOf(needle);
  while (idx >= 0 && count < cap) {
    count++;
    idx = hay.indexOf(needle, idx + needle.length);
  }
  return count;
}

/* ------------------------------------------------------------------------- */
/* read_note                                                                 */
/* ------------------------------------------------------------------------- */

export function readNote(vault: Vault, args: { note: string; maxChars?: number }) {
  const { note, others } = vault.findNote(args.note);
  const maxChars = clamp(args.maxChars ?? LIMITS.readDefaultChars, 1, LIMITS.readMaxChars);
  const body = note.lines.slice(note.bodyStartLine).join("\n");
  const truncated = body.length > maxChars;
  return {
    path: note.path,
    title: note.title,
    frontmatter: note.frontmatter,
    ...(note.frontmatterError ? { frontmatterError: note.frontmatterError } : {}),
    tags: note.tags,
    aliases: note.aliases,
    modified: new Date(note.mtimeMs).toISOString(),
    bodyStartLine: note.bodyStartLine + 1,
    bodyChars: body.length,
    truncated,
    body: truncated ? safeSlice(body, maxChars) : body,
    ...(others.length ? { otherMatches: others } : {}),
  };
}

/* ------------------------------------------------------------------------- */
/* backlinks / outgoing_links                                                */
/* ------------------------------------------------------------------------- */

function describeLink(link: LinkRef) {
  return {
    line: link.line,
    raw: link.raw,
    ...(link.subpath ? { subpath: link.subpath } : {}),
    ...(link.alias ? { alias: link.alias } : {}),
    embed: link.embed,
  };
}

export function backlinks(vault: Vault, args: { note: string; limit?: number }) {
  const { note: target } = vault.findNote(args.note);
  const limit = clamp(args.limit ?? LIMITS.linksDefault, 1, LIMITS.linksMax);
  const sources: { path: string; title: string; links: (ReturnType<typeof describeLink> & { context: string })[] }[] = [];
  let total = 0;
  for (const note of vault.allNotes()) {
    const links = note.links.filter((l) => {
      if (note.path === target.path && l.target === "") return false; // same-note heading links
      const r = vault.resolveLink(l, note.path);
      return r?.kind === "note" && r.path === target.path;
    });
    if (!links.length) continue;
    total += links.length;
    sources.push({
      path: note.path,
      title: note.title,
      links: links.map((l) => ({ ...describeLink(l), context: excerpt(note.lines[l.line - 1] ?? "", 0) })),
    });
  }
  return {
    note: { path: target.path, title: target.title },
    sourceCount: sources.length,
    linkCount: total,
    truncated: sources.length > limit,
    backlinks: sources.slice(0, limit),
  };
}

export function outgoingLinks(vault: Vault, args: { note: string }) {
  const { note } = vault.findNote(args.note);
  const links = note.links.map((l) => {
    const r = vault.resolveLink(l, note.path);
    return {
      target: l.target === "" ? note.title : l.target,
      ...describeLink(l),
      resolved: r?.path ?? null,
      kind: r?.kind ?? "unresolved",
    };
  });
  return {
    note: { path: note.path, title: note.title },
    total: links.length,
    resolvedCount: links.filter((l) => l.resolved !== null).length,
    unresolvedCount: links.filter((l) => l.resolved === null).length,
    links,
  };
}

/* ------------------------------------------------------------------------- */
/* list_notes                                                                */
/* ------------------------------------------------------------------------- */

export function listNotes(vault: Vault, args: { folder?: string; tag?: string; limit?: number }) {
  const folder = args.folder ? vault.toVaultPath(args.folder) : "";
  const tag = args.tag ? normaliseTag(args.tag) : "";
  const limit = clamp(args.limit ?? LIMITS.listDefault, 1, LIMITS.listMax);
  const notes = vault.allNotes().filter((n) => inFolder(n, folder) && (!tag || hasTag(n, tag)));
  return {
    ...(folder ? { folder } : {}),
    ...(tag ? { tag } : {}),
    total: notes.length,
    truncated: notes.length > limit,
    notes: notes.slice(0, limit).map((n) => ({
      path: n.path,
      title: n.title,
      tags: n.tags,
      modified: new Date(n.mtimeMs).toISOString(),
    })),
  };
}

/* ------------------------------------------------------------------------- */
/* helpers                                                                   */
/* ------------------------------------------------------------------------- */

export function normaliseTag(tag: string): string {
  return tag.normalize("NFC").trim().replace(/^#+/, "").replace(/\/+$/, "").toLowerCase();
}

/** Tag match is case-insensitive and includes nested tags: "project" matches "project/alpha". */
export function hasTag(note: Note, tag: string): boolean {
  return note.tags.some((t) => {
    const l = t.toLowerCase();
    return l === tag || l.startsWith(tag + "/");
  });
}

function inFolder(note: Note, folder: string): boolean {
  if (!folder) return true;
  const f = folder.replace(/\/+$/, "").toLowerCase();
  const p = note.path.toLowerCase();
  return p.startsWith(f + "/");
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Slice without splitting a surrogate pair. */
function safeSlice(s: string, n: number): string {
  return isHighSurrogate(s.charCodeAt(n - 1)) ? s.slice(0, n - 1) : s.slice(0, n);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
