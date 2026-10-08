import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Vault } from "../src/vault.js";
import { backlinks, listNotes, outgoingLinks, parseQuery, readNote, search } from "../src/tools.js";
import { SAMPLE_VAULT, makeTempVault } from "./helpers.js";

let v: Vault;
before(async () => {
  v = await Vault.open(SAMPLE_VAULT);
});

/* search ------------------------------------------------------------------ */

test("search: ranks the note about the term first and returns line-numbered snippets", () => {
  const r = search(v, { query: "starter" });
  assert.equal(r.results[0]?.path, "Areas/Cooking/Sourdough.md");
  assert.ok(r.total >= 3);
  const first = r.results[0]!;
  assert.ok(first.matches.length > 0 && first.matches.length <= 3);
  for (const m of first.matches) {
    const line = v.getNote(first.path)!.lines[m.line - 1]!;
    assert.match(line.toLowerCase(), /starter/, "line number points at the matching line");
  }
  const scores = r.results.map((h) => h.score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores, "sorted by score");
});

test("search: case-insensitive, all words must match, quoted phrases", () => {
  assert.equal(search(v, { query: "RAISED BEDS" }).results[0]?.path, "Projects/Garden Planner.md");
  assert.equal(search(v, { query: "tomatoes zzzunknown" }).total, 0);
  const phrase = search(v, { query: '"south fence"' });
  assert.deepEqual(phrase.results.map((h) => h.path), ["Projects/Garden Planner.md"]);
  assert.equal(search(v, { query: '"fence south"' }).total, 0);
});

test("search: title matches outrank body mentions", () => {
  const r = search(v, { query: "garden planner" });
  assert.equal(r.results[0]?.path, "Projects/Garden Planner.md");
  const alias = search(v, { query: "dashboard" });
  assert.equal(alias.results[0]?.path, "Home.md");
});

test("search: unicode content and case folding", () => {
  assert.deepEqual(search(v, { query: "café" }).results[0]?.path, "Café Notes.md");
  assert.ok(search(v, { query: "CRÈME BRÛLÉE" }).results.some((h) => h.path === "Café Notes.md"));
  assert.ok(search(v, { query: "кириллица" }).results.some((h) => h.path === "Café Notes.md"));
  assert.deepEqual(search(v, { query: "東京" }).results.map((h) => h.path), ["日本語メモ.md"]);
});

test("search: #tag in the query and tag/folder params filter results", () => {
  const byTag = search(v, { query: "#cooking" });
  assert.deepEqual(byTag.results.map((h) => h.path), ["Areas/Cooking/Sourdough.md"]);
  const nested = search(v, { query: "garden #project" });
  assert.deepEqual(nested.results.map((h) => h.path), ["Projects/Garden Planner.md"]);
  const tagParam = search(v, { query: "sourdough", tag: "#ideas" });
  assert.deepEqual(tagParam.results.map((h) => h.path), ["Ideas/Ideas.md"]);
  const folder = search(v, { query: "garden", folder: "People" });
  assert.deepEqual(folder.results.map((h) => h.path), ["People/Mira Okafor.md"]);
  const unicodeTag = search(v, { query: "#旅行" });
  assert.deepEqual(unicodeTag.results.map((h) => h.path), ["日本語メモ.md"]);
});

test("search: limit, empty query, and query parsing", () => {
  const r = search(v, { query: "the", limit: 2 });
  assert.equal(r.results.length, 2);
  assert.ok(r.total > 2);
  assert.throws(() => search(v, { query: "   " }), /Query is empty/);
  assert.deepEqual(parseQuery('Foo "Bar  Baz" #Tag/Sub foo'), { terms: ["foo", "bar baz"], tags: ["tag/sub"] });
});

test("search: long lines are trimmed around the match", async () => {
  const long = "lorem ".repeat(100) + "needle " + "ipsum ".repeat(100);
  const { vault, cleanup } = makeTempVault({ "Long.md": long });
  try {
    const tv = await Vault.open(vault);
    const m = search(tv, { query: "needle" }).results[0]!.matches[0]!;
    assert.ok(m.text.length <= 206);
    assert.match(m.text, /^\.\.\..*needle.*\.\.\.$/);
    assert.equal(m.line, 1);
  } finally {
    cleanup();
  }
});

/* read_note --------------------------------------------------------------- */

test("read_note: frontmatter parsed, body separated, tags and aliases", () => {
  const r = readNote(v, { note: "Projects/Garden Planner.md" });
  assert.deepEqual(r.frontmatter, {
    status: "active",
    tags: ["project/garden", "planning"],
    owner: "[[Mira Okafor]]",
    due: "2026-04-01",
    budget: 120,
  });
  assert.ok(r.body.startsWith("# Garden Planner"));
  assert.ok(!r.body.includes("status: active"));
  assert.equal(r.bodyStartLine, 10);
  assert.deepEqual(r.tags, ["project/garden", "planning", "gardening"]);
  assert.equal(r.truncated, false);
});

test("read_note: by title, alias, absolute path; note without frontmatter", () => {
  assert.equal(readNote(v, { note: "Home" }).path, "Home.md");
  assert.equal(readNote(v, { note: "Start Here" }).path, "Home.md");
  assert.equal(readNote(v, { note: "Books" }).path, "Projects/Reading List.md");
  assert.equal(readNote(v, { note: path.join(SAMPLE_VAULT, "Café Notes.md") }).path, "Café Notes.md");
  const cheat = readNote(v, { note: "Markdown Cheatsheet" });
  assert.deepEqual(cheat.frontmatter, {});
  assert.equal(cheat.bodyStartLine, 1);
});

test("read_note: size cap truncates without splitting characters", () => {
  const r = readNote(v, { note: "日本語メモ", maxChars: 10 });
  assert.equal(r.truncated, true);
  assert.equal(r.body.length, 10);
  assert.ok(r.bodyChars > 10);
});

test("read_note: ambiguous title lists other matches; unknown note suggests", () => {
  const r = readNote(v, { note: "Ideas" });
  assert.equal(r.path, "Ideas/Ideas.md");
  assert.deepEqual(r.otherMatches, ["Archive/2025/Ideas.md"]);
  assert.equal(readNote(v, { note: "Archive/2025/Ideas" }).path, "Archive/2025/Ideas.md");
  assert.throws(() => readNote(v, { note: "Sourdo" }), /Did you mean: Areas\/Cooking\/Sourdough\.md/);
});

/* backlinks --------------------------------------------------------------- */

test("backlinks: Home is linked from exactly three notes (trash excluded)", () => {
  const r = backlinks(v, { note: "Home" });
  assert.deepEqual(
    r.backlinks.map((b) => b.path),
    ["Areas/Fitness/Running Plan.md", "Projects/Garden Planner.md", "Projects/Reading List.md"],
  );
  const heading = r.backlinks[0]!.links[0]!;
  assert.equal(heading.subpath, "Start");
  assert.equal(heading.alias, "home");
  assert.equal(heading.line, 10);
});

test("backlinks: aliases, headings and embeds all count", () => {
  const r = backlinks(v, { note: "Sourdough" });
  const byPath = Object.fromEntries(r.backlinks.map((b) => [b.path, b.links]));
  assert.equal(r.sourceCount, 6);
  assert.equal(byPath["Home.md"]?.[0]?.subpath, "Feeding schedule");
  assert.equal(byPath["Projects/Garden Planner.md"]?.[0]?.alias, "starter discard");
  assert.equal(byPath["Journal/2026-01-12.md"]?.[0]?.embed, true);
  assert.equal(byPath["Journal/2026-01-12.md"]?.[0]?.subpath, "Feeding schedule");
});

test("backlinks: markdown links, escaped table pipes, frontmatter links, unicode", () => {
  const garden = backlinks(v, { note: "Garden Planner" });
  const reading = garden.backlinks.find((b) => b.path === "Projects/Reading List.md")!;
  assert.equal(reading.links.length, 2, "wikilink and relative markdown link");
  assert.ok(reading.links.some((l) => l.raw.startsWith("[the plan](")));

  const books = backlinks(v, { note: "Reading List" });
  assert.ok(books.backlinks.find((b) => b.path === "Projects/Garden Planner.md")?.links.some((l) => l.alias === "the seed book"));

  const mira = backlinks(v, { note: "Mira Okafor" });
  assert.ok(mira.backlinks.find((b) => b.path === "Projects/Garden Planner.md")?.links.some((l) => l.line === 6));

  const cafe = backlinks(v, { note: "Café Notes" });
  assert.deepEqual(cafe.backlinks.map((b) => b.path).sort(), ["Home.md", "日本語メモ.md"]);
});

test("backlinks: ambiguous link target resolves to the shortest path only", () => {
  assert.equal(backlinks(v, { note: "Ideas/Ideas" }).sourceCount, 3); // Home, Journal, Archive/2025/Ideas
  assert.equal(backlinks(v, { note: "Archive/2025/Ideas" }).sourceCount, 0);
});

test("backlinks: limit caps the number of source notes", () => {
  const r = backlinks(v, { note: "Sourdough", limit: 2 });
  assert.equal(r.backlinks.length, 2);
  assert.equal(r.truncated, true);
  assert.equal(r.sourceCount, 6);
});

/* outgoing_links ---------------------------------------------------------- */

test("outgoing_links: resolved notes, attachments and unresolved targets", () => {
  const r = outgoingLinks(v, { note: "Home" });
  assert.equal(r.total, 10);
  assert.equal(r.unresolvedCount, 1);
  const byRaw = Object.fromEntries(r.links.map((l) => [l.raw, l]));
  assert.equal(byRaw["[[Someday Maybe]]"]?.resolved, null);
  assert.equal(byRaw["[[Someday Maybe]]"]?.kind, "unresolved");
  assert.equal(byRaw["[[Reading List|what to read next]]"]?.resolved, "Projects/Reading List.md");
  assert.equal(byRaw["[[Sourdough#Feeding schedule]]"]?.subpath, "Feeding schedule");
  assert.equal(byRaw["[[日本語メモ]]"]?.resolved, "日本語メモ.md");
  assert.equal(byRaw["![[attachments/garden-layout.svg]]"]?.kind, "attachment");
  assert.equal(byRaw["![[attachments/garden-layout.svg]]"]?.embed, true);
});

test("outgoing_links: code blocks ignored, embeds by bare file name resolve", () => {
  const sour = outgoingLinks(v, { note: "Sourdough" });
  assert.deepEqual(sour.links.map((l) => l.target), ["Garden Planner"]);
  const garden = outgoingLinks(v, { note: "Garden Planner" });
  assert.ok(garden.links.some((l) => l.raw === "![[garden-layout.svg]]" && l.resolved === "attachments/garden-layout.svg"));
});

/* list_notes -------------------------------------------------------------- */

test("list_notes: all, folder (recursive), tag (nested, case-insensitive, unicode), limit", () => {
  assert.equal(listNotes(v, {}).total, 12);
  assert.deepEqual(listNotes(v, { folder: "Areas" }).notes.map((n) => n.path), [
    "Areas/Cooking/Sourdough.md",
    "Areas/Fitness/Running Plan.md",
  ]);
  assert.deepEqual(listNotes(v, { folder: "areas/cooking/" }).notes.map((n) => n.path), ["Areas/Cooking/Sourdough.md"]);
  assert.deepEqual(listNotes(v, { tag: "#JOURNAL" }).notes.map((n) => n.path), ["Journal/2026-01-12.md"]);
  assert.deepEqual(listNotes(v, { tag: "cooking/bread" }).notes.map((n) => n.path), ["Areas/Cooking/Sourdough.md"]);
  assert.deepEqual(listNotes(v, { tag: "café" }).notes.map((n) => n.path), ["Café Notes.md"]);
  assert.deepEqual(listNotes(v, { tag: "reference" }).notes.map((n) => n.path), ["Reference/Markdown Cheatsheet.md"]);
  assert.equal(listNotes(v, { tag: "123" }).total, 0);
  assert.equal(listNotes(v, { tag: "notatag" }).total, 0);
  const limited = listNotes(v, { limit: 3 });
  assert.equal(limited.notes.length, 3);
  assert.equal(limited.truncated, true);
  assert.equal(listNotes(v, { folder: "Projects", tag: "reading" }).total, 1);
});
