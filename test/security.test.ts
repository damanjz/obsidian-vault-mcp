import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { Vault } from "../src/vault.js";
import { backlinks, listNotes, readNote, search } from "../src/tools.js";
import { PROJECT_ROOT, SAMPLE_VAULT, makeTempVault, writeFile } from "./helpers.js";

const SECRET = "TOP-SECRET-OUTSIDE-VAULT";

function setup() {
  const t = makeTempVault({ "Inside.md": "inside note [[../outside]] [[Secret]]" });
  writeFile(t.base, "outside.md", SECRET);
  writeFile(t.base, "Secret.md", SECRET);
  writeFile(t.base, "outdir/Linked.md", SECRET);
  return t;
}

test("traversal: relative, mixed-separator and absolute paths outside the vault are refused", async () => {
  const { base, vault, cleanup } = setup();
  try {
    const v = await Vault.open(vault);
    const attempts = [
      "../outside.md",
      "..\\outside.md",
      "../outside",
      "Sub/../../outside.md",
      "./../outside.md",
      "a/b/../../../outside.md",
      path.join(base, "outside.md"),
      path.join(vault, "..", "outside.md"),
    ];
    for (const a of attempts) {
      assert.throws(() => readNote(v, { note: a }), /outside the vault/, `should refuse ${a}`);
      assert.throws(() => backlinks(v, { note: a }), /outside the vault/, `should refuse ${a}`);
    }
    assert.throws(() => listNotes(v, { folder: ".." }), /outside the vault/);
    assert.throws(() => search(v, { query: "x", folder: "../" }), /outside the vault/);
  } finally {
    cleanup();
  }
});

test("traversal: root-style and odd inputs never reach outside files", async () => {
  const { vault, cleanup } = setup();
  try {
    const v = await Vault.open(vault);
    for (const a of ["/etc/passwd", "/outside.md", "%2e%2e/outside.md", "outside", "Secret", "nul\u0000byte"]) {
      assert.throws(() => readNote(v, { note: a }), /not found|outside the vault|Invalid path/, `should refuse ${a}`);
    }
    // Absolute paths inside the vault are fine.
    assert.equal(readNote(v, { note: path.join(vault, "Inside.md") }).path, "Inside.md");
    // Links pointing outside stay unresolved, and no search result leaks outside text.
    assert.equal(search(v, { query: SECRET }).total, 0);
  } finally {
    cleanup();
  }
});

test("hidden folders (.obsidian, .trash) are neither indexed nor readable", async () => {
  const v = await Vault.open(SAMPLE_VAULT);
  assert.throws(() => readNote(v, { note: ".trash/Deleted Draft.md" }), /Hidden/);
  assert.throws(() => readNote(v, { note: ".obsidian/app.json" }), /Hidden/);
  assert.throws(() => readNote(v, { note: "Deleted Draft" }), /not found/);
  assert.equal(search(v, { query: "secret-trash-marker" }).total, 0);
  assert.ok(!backlinks(v, { note: "Home" }).backlinks.some((b) => b.path.includes(".trash")));
});

test("symlinks/junctions pointing outside the vault are ignored", async (t) => {
  const { base, vault, cleanup } = setup();
  try {
    let linked = 0;
    try {
      // Junctions need no special rights on Windows; on POSIX this is a plain dir symlink.
      symlinkSync(path.join(base, "outdir"), path.join(vault, "escape"), "junction");
      linked++;
    } catch {
      /* not supported here */
    }
    try {
      symlinkSync(path.join(base, "outside.md"), path.join(vault, "Escape File.md"), "file");
      linked++;
    } catch {
      /* file symlinks need Developer Mode or admin on Windows */
    }
    if (linked === 0) {
      t.skip("cannot create symlinks on this system");
      return;
    }
    const v = await Vault.open(vault);
    assert.deepEqual(
      v.allNotes().map((n) => n.path),
      ["Inside.md"],
    );
    assert.equal(search(v, { query: SECRET }).total, 0);
    assert.throws(() => readNote(v, { note: "escape/Linked.md" }), /not found/);
    assert.throws(() => readNote(v, { note: "Escape File" }), /not found/);
  } finally {
    cleanup();
  }
});

test("symlinks inside the vault are followed once (no loops)", async (t) => {
  const { vault, cleanup } = makeTempVault({ "Real/Note.md": "hello" });
  try {
    try {
      symlinkSync(path.join(vault, "Real"), path.join(vault, "Alias"), "junction");
      symlinkSync(vault, path.join(vault, "Real", "Loop"), "junction");
    } catch {
      t.skip("cannot create symlinks on this system");
      return;
    }
    const v = await Vault.open(vault);
    assert.ok(v.noteCount >= 1 && v.noteCount <= 2, `bounded note count, got ${v.noteCount}`);
  } finally {
    cleanup();
  }
});

test("source code only uses read-only filesystem calls (read-only by construction)", () => {
  const srcDir = path.join(PROJECT_ROOT, "src");
  const allowed = new Set(["realpath", "stat", "readdir", "readFile"]);
  const used = new Set<string>();
  for (const file of readdirSync(srcDir)) {
    const text = readFileSync(path.join(srcDir, file), "utf8");
    const imports = [...text.matchAll(/from "(node:)?fs(\/promises)?"/g)];
    if (file !== "vault.ts") assert.equal(imports.length, 0, `${file} must not import fs`);
    if (file === "vault.ts") assert.match(text, /import \{ promises as fs \} from "node:fs";/);
    for (const m of text.matchAll(/\bfs\.(\w+)/g)) used.add(m[1]!);
  }
  for (const name of used) assert.ok(allowed.has(name), `fs.${name} is not a read-only call`);
  assert.ok(used.has("readFile"));
});

test("source code makes no network calls", () => {
  const srcDir = path.join(PROJECT_ROOT, "src");
  for (const file of readdirSync(srcDir)) {
    const text = readFileSync(path.join(srcDir, file), "utf8");
    assert.doesNotMatch(text, /\bfetch\s*\(|node:(http|https|net|dgram|tls)\b|from "(http|https|net)"/, file);
  }
});
