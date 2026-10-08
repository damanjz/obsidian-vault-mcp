import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SAMPLE_VAULT, SERVER_ENTRY } from "./helpers.js";

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };

async function connect(args: string[], env: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY, ...args],
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "e2e-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as TextResult;
  const text = res.content[0]?.text ?? "";
  return { isError: res.isError === true, text, json: res.isError ? null : JSON.parse(text) };
}

let client: Client;
before(async () => {
  client = await connect([SAMPLE_VAULT]);
});
after(async () => {
  await client?.close();
});

test("e2e: server advertises exactly five read-only tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["backlinks", "list_notes", "outgoing_links", "read_note", "search"]);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} readOnlyHint`);
    assert.equal(t.annotations?.destructiveHint, false, `${t.name} destructiveHint`);
    assert.equal(t.annotations?.openWorldHint, false, `${t.name} openWorldHint`);
  }
});

test("e2e: every tool returns JSON over stdio", async () => {
  const s = await call(client, "search", { query: "starter", limit: 2 });
  assert.equal(s.json.results[0].path, "Areas/Cooking/Sourdough.md");
  assert.ok(s.json.results.length <= 2);

  const r = await call(client, "read_note", { note: "Home", max_chars: 50 });
  assert.equal(r.json.path, "Home.md");
  assert.equal(r.json.truncated, true);
  assert.deepEqual(r.json.aliases, ["Start Here", "Dashboard"]);

  const b = await call(client, "backlinks", { note: "Home" });
  assert.equal(b.json.sourceCount, 3);

  const o = await call(client, "outgoing_links", { note: "Home" });
  assert.equal(o.json.unresolvedCount, 1);

  const l = await call(client, "list_notes", { tag: "日本語" });
  assert.deepEqual(
    l.json.notes.map((n: { path: string }) => n.path),
    ["日本語メモ.md"],
  );
});

test("e2e: traversal attempts and unknown notes come back as tool errors", async () => {
  const t = await call(client, "read_note", { note: "../../package.json" });
  assert.equal(t.isError, true);
  assert.match(t.text, /outside the vault/);

  const h = await call(client, "read_note", { note: ".obsidian/app.json" });
  assert.equal(h.isError, true);

  const n = await call(client, "backlinks", { note: "No Such Note" });
  assert.equal(n.isError, true);
  assert.match(n.text, /not found/i);

  const bad = await call(client, "search", { query: "" });
  assert.equal(bad.isError, true, "schema validation rejects an empty query");
});

test("e2e: vault path from the VAULT_PATH environment variable", async () => {
  const c = await connect([], { VAULT_PATH: SAMPLE_VAULT });
  try {
    const l = await call(c, "list_notes", {});
    assert.equal(l.json.total, 12);
  } finally {
    await c.close();
  }
});

test("e2e: missing or invalid vault path exits with an error", () => {
  const env = { ...process.env };
  delete env.VAULT_PATH;
  const none = spawnSync(process.execPath, [SERVER_ENTRY], { env, encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /no vault path/i);
  assert.equal(none.stdout, "", "nothing but protocol on stdout");

  const missing = spawnSync(process.execPath, [SERVER_ENTRY, SAMPLE_VAULT + "-missing"], { env, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /does not exist/);

  const help = spawnSync(process.execPath, [SERVER_ENTRY, "--help"], { env, encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stderr, /Usage:/);
});
