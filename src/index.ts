#!/usr/bin/env node
/**
 * obsidian-vault-mcp: read-only MCP server for an Obsidian vault, over stdio.
 *
 *   obsidian-vault-mcp <vault-path>
 *   VAULT_PATH=<vault-path> obsidian-vault-mcp
 *
 * stdout carries the MCP protocol only; diagnostics go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { Vault } from "./vault.js";
import { VERSION } from "./version.js";

const USAGE = `obsidian-vault-mcp ${VERSION}
Read-only MCP server for an Obsidian vault (stdio transport).

Usage:
  obsidian-vault-mcp <vault-path>
  VAULT_PATH=<vault-path> obsidian-vault-mcp

Options:
  -h, --help     Show this help
  -v, --version  Show the version
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    process.stderr.write(USAGE);
    return;
  }
  if (args.includes("-v") || args.includes("--version")) {
    process.stderr.write(`${VERSION}\n`);
    return;
  }
  const vaultPath = args.find((a) => !a.startsWith("-")) ?? process.env.VAULT_PATH;
  if (!vaultPath) {
    process.stderr.write(`Error: no vault path. Pass it as an argument or set VAULT_PATH.\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const log = (m: string) => process.stderr.write(`[obsidian-vault-mcp] ${m}\n`);
  const vault = await Vault.open(vaultPath, { log });
  const s = vault.stats;
  log(`vault ${vault.root}: ${s.notes} notes, ${s.attachments} other files indexed in ${s.ms} ms`);

  const server = createServer(vault);
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  process.stderr.write(`[obsidian-vault-mcp] ${(err as Error).message ?? String(err)}\n`);
  process.exit(1);
});
