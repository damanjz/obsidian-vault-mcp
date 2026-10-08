/**
 * Parsing helpers for Obsidian-flavoured Markdown: frontmatter, wikilinks,
 * Markdown links, embeds and tags. Pure functions, no I/O.
 */

export interface LinkRef {
  /** Link target as written, without heading/alias, e.g. "Folder/Note" or "image.png". Empty for same-note links. */
  target: string;
  /** Heading or block reference after '#', e.g. "Setup" or "^block-id". */
  subpath?: string;
  /** Display text after '|' (wikilinks) or the [text] part (Markdown links). */
  alias?: string;
  /** True for ![[...]] and ![...](...) embeds. */
  embed: boolean;
  /** 'wikilink' for [[...]], 'markdown' for [text](path). */
  syntax: "wikilink" | "markdown";
  /** 1-based line number in the file. */
  line: number;
  /** The link exactly as it appears in the file. */
  raw: string;
}

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  frontmatterError?: string;
  /** 0-based index of the first body line (after the closing frontmatter fence). */
  bodyStartLine: number;
  tags: string[];
  aliases: string[];
  links: LinkRef[];
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const WIKILINK_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
const MDLINK_RE = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g;
const INLINE_CODE_RE = /(`+)(?:(?!\1)[^\n])+?\1/g;
const TAG_RE = /(^|[\s,;:(\[{])#([\p{L}\p{N}\p{M}_\-/]+)/gu;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.\-]*:/i;

/** Split text into lines, accepting \n and \r\n. */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Locate a YAML frontmatter block at the very start of the file. */
export function findFrontmatter(lines: string[]): { raw: string[]; bodyStartLine: number } | null {
  const first = (lines[0] ?? "").replace(/^﻿/, "");
  if (first.trimEnd() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    const l = (lines[i] ?? "").trimEnd();
    if (l === "---" || l === "...") return { raw: lines.slice(1, i), bodyStartLine: i + 1 };
  }
  return null;
}

export function parseNote(lines: string[]): ParsedNote {
  const fm = findFrontmatter(lines);
  let frontmatter: Record<string, unknown> = {};
  let frontmatterError: string | undefined;
  if (fm) {
    try {
      frontmatter = parseYamlSubset(fm.raw);
    } catch (err) {
      frontmatterError = (err as Error).message;
    }
  }
  const bodyStartLine = fm ? fm.bodyStartLine : 0;

  const links: LinkRef[] = [];
  // Obsidian treats wikilinks inside frontmatter values (properties) as links too.
  if (fm) {
    for (let i = 0; i < fm.raw.length; i++) collectWikilinks(fm.raw[i] ?? "", i + 2, links);
  }

  const inlineTags: string[] = [];
  let fence: string | null = null;
  for (let i = bodyStartLine; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      if (fence === null) {
        fence = marker;
        continue;
      }
      if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
        fence = null;
        continue;
      }
    }
    if (fence !== null) continue;
    const text = blankInlineCode(line);
    collectWikilinks(text, i + 1, links, line);
    collectMarkdownLinks(text, i + 1, links, line);
    collectInlineTags(text, inlineTags);
  }

  const tags = dedupeCaseInsensitive([...frontmatterList(frontmatter, ["tags", "tag"], /[,\s]+/), ...inlineTags]
    .map((t) => t.replace(/^#/, "").replace(/\/+$/, ""))
    .filter((t) => t.length > 0 && /[^\p{N}/]/u.test(t)));
  const aliases = dedupeCaseInsensitive(frontmatterList(frontmatter, ["aliases", "alias"], /,/));

  return { frontmatter, frontmatterError, bodyStartLine, tags, aliases, links };
}

/** Replace inline code spans with spaces so links/tags inside them are ignored but columns stay aligned. */
function blankInlineCode(line: string): string {
  if (!line.includes("`")) return line;
  return line.replace(INLINE_CODE_RE, (m) => " ".repeat(m.length));
}

function collectWikilinks(text: string, lineNo: number, out: LinkRef[], original = text): void {
  if (!text.includes("[[")) return;
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    // "\|" is how a pipe is escaped inside Markdown tables.
    const inner = (m[2] ?? "").replace(/\\\|/g, "|");
    const pipe = inner.indexOf("|");
    const targetPart = pipe >= 0 ? inner.slice(0, pipe) : inner;
    const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : undefined;
    const { target, subpath } = splitSubpath(targetPart);
    out.push({
      target,
      ...(subpath ? { subpath } : {}),
      ...(alias ? { alias } : {}),
      embed: m[1] === "!",
      syntax: "wikilink",
      line: lineNo,
      raw: original.slice(m.index, m.index + m[0].length),
    });
  }
}

function collectMarkdownLinks(text: string, lineNo: number, out: LinkRef[], original: string): void {
  if (!text.includes("](")) return;
  MDLINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MDLINK_RE.exec(text)) !== null) {
    let href = (m[3] ?? "").trim();
    if (href.startsWith("<") && href.endsWith(">")) href = href.slice(1, -1).trim();
    if (!href || href.startsWith("#") || URL_SCHEME_RE.test(href) || href.startsWith("//")) continue;
    let decoded = href;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      // keep the raw href if it is not valid percent-encoding
    }
    const { target, subpath } = splitSubpath(decoded);
    const alias = (m[2] ?? "").trim();
    out.push({
      target,
      ...(subpath ? { subpath } : {}),
      ...(alias ? { alias } : {}),
      embed: m[1] === "!",
      syntax: "markdown",
      line: lineNo,
      raw: original.slice(m.index, m.index + m[0].length),
    });
  }
}

function splitSubpath(s: string): { target: string; subpath?: string } {
  const hash = s.indexOf("#");
  if (hash < 0) return { target: s.trim() };
  const subpath = s.slice(hash + 1).trim();
  return { target: s.slice(0, hash).trim(), ...(subpath ? { subpath } : {}) };
}

function collectInlineTags(text: string, out: string[]): void {
  if (!text.includes("#")) return;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text)) !== null) out.push(m[2] ?? "");
}

function frontmatterList(fm: Record<string, unknown>, keys: string[], splitter: RegExp): string[] {
  const out: string[] = [];
  for (const key of Object.keys(fm)) {
    if (!keys.includes(key.toLowerCase())) continue;
    const v = fm[key];
    const items = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
    for (const item of items) {
      if (item === null || item === undefined || typeof item === "object") continue;
      const s = String(item);
      for (const part of Array.isArray(v) ? [s] : s.split(splitter)) {
        const t = part.trim();
        if (t) out.push(t);
      }
    }
  }
  return out;
}

function dedupeCaseInsensitive(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Minimal YAML reader for Obsidian properties.                              */
/* Covers: scalars, quoted strings, numbers, booleans, null, flow lists,     */
/* block lists, block scalars (| and >) and nested maps. Anything else is    */
/* kept as a raw string rather than guessed.                                 */
/* ------------------------------------------------------------------------- */

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"\-][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*))?$/;

export function parseYamlSubset(lines: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = stripTrailingSpace(lines[i] ?? "");
    if (isBlankOrComment(line)) {
      i++;
      continue;
    }
    if (/^\s/.test(line)) throw new Error(`Unexpected indentation in frontmatter line ${i + 1}`);
    const m = KEY_RE.exec(line);
    if (!m) throw new Error(`Cannot parse frontmatter line ${i + 1}: ${line.slice(0, 80)}`);
    const key = unquoteKey(m[1] ?? "");
    const rest = (m[2] ?? "").trim();
    i++;

    // Gather the indented (or "- " list) continuation lines that belong to this key.
    const block: string[] = [];
    while (i < lines.length) {
      const next = stripTrailingSpace(lines[i] ?? "");
      if (next === "" || /^\s/.test(next) || (rest === "" && /^-(\s|$)/.test(next))) {
        block.push(next);
        i++;
      } else break;
    }
    while (block.length && (block[block.length - 1] ?? "").trim() === "") block.pop();

    if (rest !== "" && !/^[|>][+-]?$/.test(stripComment(rest))) {
      result[key] = parseScalar(rest);
    } else if (/^[|>]/.test(rest)) {
      const body = dedent(block);
      result[key] = rest.startsWith("|") ? body.join("\n") : foldLines(body);
    } else if (block.length === 0) {
      result[key] = null;
    } else {
      result[key] = parseBlock(dedent(block));
    }
  }
  return result;
}

function parseBlock(block: string[]): unknown {
  const content = block.filter((l) => !isBlankOrComment(l));
  if (content.every((l) => /^-(\s|$)/.test(l))) {
    return content.map((l) => {
      const item = l.replace(/^-\s*/, "");
      return item === "" ? null : parseScalar(item);
    });
  }
  if (content.some((l) => /^-(\s|$)/.test(l))) {
    // Lists of maps and other mixed structures: keep the raw text.
    return block.join("\n");
  }
  try {
    return parseYamlSubset(block);
  } catch {
    return block.join("\n");
  }
}

export function parseScalar(input: string): unknown {
  const s = input.trim();
  if (s.startsWith('"')) {
    const end = findClosingQuote(s, '"');
    if (end > 0) {
      return s.slice(1, end).replace(/\\(["\\\/nrt])/g, (_, c: string) =>
        c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c,
      );
    }
    return s;
  }
  if (s.startsWith("'")) {
    const end = findClosingQuote(s, "'");
    return end > 0 ? s.slice(1, end).replace(/''/g, "'") : s;
  }
  if (s.startsWith("[")) {
    const close = s.lastIndexOf("]");
    if (close > 0) return splitFlow(s.slice(1, close)).map((p) => parseScalar(p));
    return s;
  }
  const v = stripComment(s);
  if (v === "" || v === "~" || /^null$/i.test(v)) return null;
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
  if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v) && !/^[-+]?0\d/.test(v)) return Number(v);
  return v;
}

function findClosingQuote(s: string, q: string): number {
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (q === '"' && c === "\\") {
      i++;
      continue;
    }
    if (c === q) {
      if (q === "'" && s[i + 1] === "'") {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

function splitFlow(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"') {
        cur += s[++i] ?? "";
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function stripComment(s: string): string {
  const idx = s.search(/\s#/);
  return (idx >= 0 ? s.slice(0, idx) : s).trim();
}

function stripTrailingSpace(s: string): string {
  return s.replace(/\s+$/, "");
}

function isBlankOrComment(l: string): boolean {
  const t = l.trim();
  return t === "" || t.startsWith("#");
}

function unquoteKey(k: string): string {
  const s = k.trim();
  if (s.startsWith('"') || s.startsWith("'")) {
    const v = parseScalar(s);
    return typeof v === "string" ? v : s;
  }
  return s;
}

function dedent(block: string[]): string[] {
  let min = Infinity;
  for (const l of block) {
    if (l.trim() === "") continue;
    const n = (/^\s*/.exec(l)?.[0] ?? "").length;
    if (n < min) min = n;
  }
  if (!Number.isFinite(min)) return block.map(() => "");
  return block.map((l) => l.slice(min));
}

function foldLines(lines: string[]): string {
  return lines
    .join("\n")
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, " "))
    .join("\n");
}
