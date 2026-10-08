# obsidian-vault-mcp

A small, read-only [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI assistant search and read an Obsidian vault: full-text search, notes with parsed frontmatter, tags, backlinks and outgoing links.

## Why

- **Read-only.** There are no write tools. The code only calls `readdir`, `stat`, `realpath` and `readFile`, and a test enforces that.
- **Local.** It talks over stdio. It makes no network calls and has no telemetry.
- **Obsidian-aware.** It understands `[[Note|alias]]`, `[[Note#Heading]]`, `![[embeds]]`, Markdown links, frontmatter `tags`/`aliases` and inline `#tags`, including nested tags. It resolves links the way Obsidian does.
- **Small.** Two runtime dependencies: `@modelcontextprotocol/sdk` and `zod`. There is no search engine library. Ranking is BM25 over an in-memory index, and only changed files are re-read.

## Install

Needs Node.js 20 or newer.

```sh
git clone <this repo> obsidian-vault-mcp
cd obsidian-vault-mcp
npm install
npm run build
```

Try it against the bundled sample vault:

```sh
node dist/index.js examples/sample-vault
```

## Configure

Give it the vault path as the first argument or in the `VAULT_PATH` environment variable. Use absolute paths.

**Claude Code**

```sh
claude mcp add obsidian-vault -- node /abs/path/obsidian-vault-mcp/dist/index.js "/abs/path/to/vault"
```

**Claude Desktop** (`claude_desktop_config.json`), or a project `.mcp.json`:

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "node",
      "args": ["/abs/path/obsidian-vault-mcp/dist/index.js"],
      "env": { "VAULT_PATH": "/abs/path/to/vault" }
    }
  }
}
```

On Windows, write paths as `C:/Users/you/Vault` or escape each backslash (`C:\\Users\\you\\Vault`).

## Tools

Every tool is annotated `readOnlyHint: true` and `openWorldHint: false`, and returns JSON text. Paths are relative to the vault and use forward slashes. Where a tool takes `note`, you can give a path (`Projects/Plan.md` or `Projects/Plan`), a title (`Plan`) or a frontmatter alias.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `search` | `query`, `limit` (default 10, max 100), `folder`, `tag` | Notes ranked by relevance, each with path, title, tags, score and up to 3 matching lines with line numbers |
| `read_note` | `note`, `max_chars` (default 40,000, max 200,000) | Parsed frontmatter, tags, aliases, body and a `truncated` flag. If notes share a title, the others are listed in `otherMatches` |
| `backlinks` | `note`, `limit` (default 200) | Notes linking to the note, with line, raw link, alias, heading or block subpath, embed flag and context |
| `outgoing_links` | `note` | Each link marked as resolved (note or attachment path) or unresolved, with resolved and unresolved counts |
| `list_notes` | `folder`, `tag`, `limit` (default 200, max 2,000) | Notes sorted by path, with tags and modified time |

**Search syntax.** Search ignores case and every word must match. `"quoted phrase"` matches the exact phrase. `#tag` filters by tag. Example: `budget "q3 plan" #work`. Matches in the title or an alias rank higher.

**Tags** come from frontmatter (`tags`/`tag`, as a list or a string) and from inline `#tags`. Matching ignores case and includes nested tags, so `project` also matches `project/alpha`. A tag made only of digits (`#123`) is not a tag, and neither is anything inside code.

**Links** count wikilinks, embeds, internal Markdown links (`[text](Other%20Note.md)`) and wikilinks inside frontmatter properties. Links inside code blocks and inline code are ignored. A link resolves in this order:

1. The exact vault path.
2. The note with that name in the linking note's own folder.
3. The shortest path, then alphabetical order.

## Security

- The vault root is resolved to its real path once at startup.
- `..` paths, absolute paths outside the vault, and NUL bytes are refused with an "outside the vault" error. Absolute paths inside the vault work.
- Any file or folder whose name starts with a dot (`.obsidian`, `.trash`, `.git`) is skipped and cannot be read.
- Symlinks and junctions are resolved, and anything whose real path is outside the vault is ignored. Each file's real path is checked again right before it is read. Symlink loops are followed only once.
- Tool input never becomes a filesystem path. Notes are served from the in-memory index, which holds only files that passed these checks.
- Notes larger than 5 MB are skipped. Responses are capped by the `limit` and `max_chars` arguments.
- The index reloads from disk at most every 2 seconds, and only re-reads files whose size or modified time changed.

## Development

```sh
npm run build   # compile src/ to dist/
npm test        # compile src/ and test/, then run all tests with node:test
```

The tests cover:

- Frontmatter and link parsing.
- Link resolution.
- Every tool.
- Path-traversal and symlink attempts.
- Unicode.
- An end-to-end run that starts the server over stdio and calls every tool through the MCP SDK client.

`examples/sample-vault/` is a small vault of invented notes used by the tests.

## License

MIT, see [LICENSE](LICENSE).
