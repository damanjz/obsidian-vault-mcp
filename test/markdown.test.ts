import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNote, parseYamlSubset, splitLines } from "../src/markdown.js";

const parse = (text: string) => parseNote(splitLines(text));

test("frontmatter: scalars, flow lists, block lists, nested maps, block scalars", () => {
  const fm = parseYamlSubset([
    "title: Plain text",
    'quoted: "a: b # not a comment"',
    "single: 'it''s'",
    "count: 42",
    "ratio: -1.5",
    "zip: 01234",
    "done: true",
    "empty:",
    "nothing: null",
    "date: 2026-01-05",
    "tags: [one, \"two, three\", four]",
    "aliases:",
    "  - First",
    "  - 'Second'",
    "list_same_indent:",
    "- x",
    "- y",
    "meta:",
    "  owner: Sam",
    "  level: 2",
    "notes: |",
    "  line one",
    "  line two",
    "folded: >",
    "  joined",
    "  words",
    "comment: value # trailing comment",
  ]);
  assert.deepEqual(fm, {
    title: "Plain text",
    quoted: "a: b # not a comment",
    single: "it's",
    count: 42,
    ratio: -1.5,
    zip: "01234",
    done: true,
    empty: null,
    nothing: null,
    date: "2026-01-05",
    tags: ["one", "two, three", "four"],
    aliases: ["First", "Second"],
    list_same_indent: ["x", "y"],
    meta: { owner: "Sam", level: 2 },
    notes: "line one\nline two",
    folded: "joined words",
    comment: "value",
  });
});

test("frontmatter: malformed YAML is reported, not thrown", () => {
  const n = parse("---\n  bad indent: 1\n---\nBody");
  assert.ok(n.frontmatterError);
  assert.deepEqual(n.frontmatter, {});
  assert.equal(n.bodyStartLine, 3);
});

test("frontmatter: only recognised at the very top, BOM tolerated, CRLF handled", () => {
  assert.equal(parse("Intro\n---\na: 1\n---").bodyStartLine, 0);
  const n = parse("﻿---\r\na: 1\r\n---\r\nBody");
  assert.deepEqual(n.frontmatter, { a: 1 });
  assert.equal(n.bodyStartLine, 3);
});

test("wikilinks: plain, alias, heading, block ref, embed, escaped table pipe", () => {
  const n = parse(
    [
      "[[Plain]] [[Target|Shown]] [[Doc#Section Two]] [[Doc#^abc123]]",
      "![[Embedded Note]] ![[image.png|200]] [[Folder/Deep Note#H|alias]]",
      "| col | [[Table Note\\|label]] |",
      "[[#Local heading]]",
    ].join("\n"),
  );
  const simple = n.links.map((l) => [l.target, l.subpath ?? null, l.alias ?? null, l.embed, l.line]);
  assert.deepEqual(simple, [
    ["Plain", null, null, false, 1],
    ["Target", null, "Shown", false, 1],
    ["Doc", "Section Two", null, false, 1],
    ["Doc", "^abc123", null, false, 1],
    ["Embedded Note", null, null, true, 2],
    ["image.png", null, "200", true, 2],
    ["Folder/Deep Note", "H", "alias", false, 2],
    ["Table Note", null, "label", false, 3],
    ["", "Local heading", null, false, 4],
  ]);
  assert.equal(n.links[1]?.raw, "[[Target|Shown]]");
});

test("markdown links: internal only, percent-decoded, angle brackets, headings", () => {
  const n = parse(
    "[a](Some%20Note.md) [b](<Other Note.md#Part>) [c](https://example.com) [d](#local) [e](mailto:x@y.z) ![f](pic.png)",
  );
  assert.deepEqual(
    n.links.map((l) => [l.target, l.subpath ?? null, l.embed, l.syntax]),
    [
      ["Some Note.md", null, false, "markdown"],
      ["Other Note.md", "Part", false, "markdown"],
      ["pic.png", null, true, "markdown"],
    ],
  );
});

test("links and tags inside code are ignored", () => {
  const n = parse(
    ["```js", "[[In Fence]] #infence", "```", "`[[Inline]]` and `#inline` but [[Real]] #real", "~~~", "[[Tilde]]", "~~~"].join(
      "\n",
    ),
  );
  assert.deepEqual(
    n.links.map((l) => l.target),
    ["Real"],
  );
  assert.deepEqual(n.tags, ["real"]);
});

test("links in frontmatter properties count, with correct line numbers", () => {
  const n = parse('---\nowner: "[[Sam Lee]]"\nrelated:\n  - "[[Plan]]"\n---\nBody [[Body Link]]');
  assert.deepEqual(
    n.links.map((l) => [l.target, l.line]),
    [
      ["Sam Lee", 2],
      ["Plan", 4],
      ["Body Link", 6],
    ],
  );
});

test("tags: frontmatter list/string/hash forms, inline, nested, unicode; excludes numbers, headings, URLs", () => {
  const n = parse(
    [
      "---",
      'tags: "alpha, #beta gamma" # an unquoted #beta would be a YAML comment',
      "---",
      "# Heading is not a tag",
      "Inline #delta and #area/sub and #日本語 and #café.",
      "Not tags: #123, issue#5, https://x.y/#frag, \\#escaped, C# code",
      "Dup #ALPHA",
    ].join("\n"),
  );
  assert.deepEqual(n.tags, ["alpha", "beta", "gamma", "delta", "area/sub", "日本語", "café"]);
});

test("aliases: list and comma-separated string", () => {
  assert.deepEqual(parse("---\naliases: [One, Two]\n---").aliases, ["One", "Two"]);
  assert.deepEqual(parse("---\nalias: One, Two\n---").aliases, ["One", "Two"]);
});
