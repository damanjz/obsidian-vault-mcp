# obsidian-vault-mcp

Read-only MCP server (stdio) for searching an Obsidian vault. TypeScript, Node 20+.

## Commands
- `npm install` - dependencies (runtime: @modelcontextprotocol/sdk, zod only)
- `npm run build` - compile `src/` to `dist/`
- `npm test` - compile `src/` + `test/` to `.test-build/` and run node:test (unit, security, e2e over stdio)
- `node dist/index.js examples/sample-vault` - run against the sample vault

## Layout
- `src/markdown.ts` - frontmatter, links, tags (pure)
- `src/vault.ts` - index, path guard, link resolution (only file that touches fs)
- `src/tools.ts` - tool logic; `src/server.ts` - MCP registration; `src/index.ts` - CLI
- `examples/sample-vault/` - invented notes used by tests; never copy real vault content here

## Rules
- Read-only: no write tools and no fs write calls; `test/security.test.ts` enforces this.
- No network calls, no telemetry, no new runtime dependencies without asking.
- No emoji anywhere.

## Definition of done
- `npm run build` and `npm test` pass.
- Run the built server for real against a vault and check the numbers (note count, search time, backlinks).

## Ask first
- Publishing (npm, GitHub repo), pushing, or changing the license.
