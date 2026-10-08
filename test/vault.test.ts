import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, utimesSync } from "node:fs";
import path from "node:path";
import { Vault } from "../src/vault.js";
import { SAMPLE_VAULT, makeTempVault, writeFile } from "./helpers.js";

test("indexes every note in the sample vault and skips .obsidian and .trash", async () => {
  const v = await Vault.open(SAMPLE_VAULT);
  const paths = v.allNotes().map((n) => n.path);
  assert.equal(paths.length, 12);
  assert.ok(paths.includes("Home.md"));
  assert.ok(paths.includes("日本語メモ.md"));
  assert.ok(!paths.some((p) => p.startsWith(".")));
  assert.equal(v.stats.attachments, 1);
});

test("findNote: by path (with/without .md, any case), title, alias", async () => {
  const v = await Vault.open(SAMPLE_VAULT);
  assert.equal(v.findNote("Projects/Garden Planner.md").note.path, "Projects/Garden Planner.md");
  assert.equal(v.findNote("projects/garden planner").note.path, "Projects/Garden Planner.md");
  assert.equal(v.findNote("Garden Planner").note.path, "Projects/Garden Planner.md");
  assert.equal(v.findNote("Dashboard").note.path, "Home.md"); // alias
  assert.equal(v.findNote("Starter").note.path, "Areas/Cooking/Sourdough.md"); // string alias
  assert.throws(() => v.findNote("Planner"), /Note not found: Planner\. Did you mean: Projects\/Garden Planner\.md/);
});

test("findNote: duplicate titles pick the shortest path and list the others", async () => {
  const v = await Vault.open(SAMPLE_VAULT);
  const r = v.findNote("Ideas");
  assert.equal(r.note.path, "Ideas/Ideas.md");
  assert.deepEqual(r.others, ["Archive/2025/Ideas.md"]);
});

test("resolveTarget: Obsidian-style resolution rules", async () => {
  const { vault, cleanup } = makeTempVault({
    "Note.md": "",
    "A/Note.md": "",
    "D/Dup.md": "",
    "E/Dup.md": "",
    "A/B/Deep.md": "",
    "C/Deep.md": "",
    "img/pic.png": "x",
    "A/pic.png": "x",
  });
  try {
    const v = await Vault.open(vault);
    assert.deepEqual(v.resolveTarget("Note", "X.md"), { kind: "note", path: "Note.md" }); // shortest path
    assert.deepEqual(v.resolveTarget("Note", "A/Other.md"), { kind: "note", path: "Note.md" }); // exact vault path wins
    assert.deepEqual(v.resolveTarget("Dup", "E/x.md"), { kind: "note", path: "E/Dup.md" }); // same folder first
    assert.deepEqual(v.resolveTarget("Dup", "X.md"), { kind: "note", path: "D/Dup.md" }); // then alphabetical
    assert.deepEqual(v.resolveTarget("B/Deep", "X.md"), { kind: "note", path: "A/B/Deep.md" }); // path suffix
    assert.deepEqual(v.resolveTarget("C/Deep.md", "X.md"), { kind: "note", path: "C/Deep.md" }); // exact path
    assert.deepEqual(v.resolveTarget("Deep", "A/B/x.md"), { kind: "note", path: "A/B/Deep.md" });
    assert.deepEqual(v.resolveTarget("../Note.md", "A/x.md", true), { kind: "note", path: "Note.md" }); // relative md link
    assert.deepEqual(v.resolveTarget("pic.png", "X.md"), { kind: "attachment", path: "A/pic.png" });
    assert.deepEqual(v.resolveTarget("img/pic.png", "X.md"), { kind: "attachment", path: "img/pic.png" });
    assert.equal(v.resolveTarget("Missing", "X.md"), null);
    assert.equal(v.resolveTarget("../../outside", "X.md"), null);
    assert.deepEqual(v.resolveTarget("", "A/Note.md"), { kind: "note", path: "A/Note.md" });
  } finally {
    cleanup();
  }
});

test("refresh picks up added, modified and deleted notes", async () => {
  const { vault, cleanup } = makeTempVault({ "One.md": "first version", "Two.md": "[[One]]" });
  try {
    const v = await Vault.open(vault, { refreshIntervalMs: 0 });
    assert.equal(v.noteCount, 2);

    writeFile(vault, "Three.md", "new note #fresh");
    writeFile(vault, "One.md", "second version, longer");
    const future = new Date(Date.now() + 5000);
    utimesSync(path.join(vault, "One.md"), future, future);
    rmSync(path.join(vault, "Two.md"));

    const stats = await v.refresh();
    assert.equal(stats.notes, 2);
    assert.equal(v.findNote("One").note.lines[0], "second version, longer");
    assert.deepEqual(v.findNote("Three").note.tags, ["fresh"]);
    assert.throws(() => v.findNote("Two"), /not found/i);
  } finally {
    cleanup();
  }
});

test("refresh is throttled by refreshIntervalMs", async () => {
  const { vault, cleanup } = makeTempVault({ "One.md": "x" });
  try {
    const v = await Vault.open(vault, { refreshIntervalMs: 60_000 });
    writeFile(vault, "Two.md", "y");
    await v.refresh();
    assert.equal(v.noteCount, 1, "within the interval the cached index is used");
    await v.refresh(true);
    assert.equal(v.noteCount, 2);
  } finally {
    cleanup();
  }
});

test("unicode: NFD file names are normalised to NFC for lookup and links", async () => {
  const nfd = "Café Plan.md"; // e + combining acute
  const { vault, cleanup } = makeTempVault({ [nfd]: "menu", "Index.md": "[[Café Plan]]" });
  try {
    const v = await Vault.open(vault);
    const note = v.findNote("Café Plan").note; // NFC input
    assert.equal(note.path, "Café Plan.md".normalize("NFC"));
    const link = v.findNote("Index").note.links[0]!;
    assert.equal(v.resolveLink(link, "Index.md")?.path, note.path);
  } finally {
    cleanup();
  }
});

test("oversized notes are skipped", async () => {
  const { vault, cleanup } = makeTempVault({ "Small.md": "ok", "Big.md": "x".repeat(2000) });
  try {
    const logs: string[] = [];
    const v = await Vault.open(vault, { maxNoteBytes: 1000, log: (m) => logs.push(m) });
    assert.deepEqual(
      v.allNotes().map((n) => n.path),
      ["Small.md"],
    );
    assert.equal(v.stats.skipped, 1);
    assert.match(logs.join("\n"), /Big\.md/);
  } finally {
    cleanup();
  }
});

test("open() rejects a missing path and a file path", async () => {
  await assert.rejects(Vault.open(path.join(SAMPLE_VAULT, "does-not-exist")), /does not exist/);
  await assert.rejects(Vault.open(path.join(SAMPLE_VAULT, "Home.md")), /not a directory/);
  await assert.rejects(Vault.open(""), /No vault path/);
});
