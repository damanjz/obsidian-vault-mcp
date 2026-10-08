import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Vault, VaultError } from "./vault.js";
import { LIMITS, backlinks, listNotes, outgoingLinks, readNote, search } from "./tools.js";
import { VERSION } from "./version.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const noteArg = z
  .string()
  .min(1)
  .describe('Note path relative to the vault ("Projects/Plan.md" or "Projects/Plan"), or a note title or alias ("Plan").');

/** Build an MCP server exposing read-only tools over the given vault. */
export function createServer(vault: Vault): McpServer {
  const server = new McpServer(
    { name: "obsidian-vault-mcp", version: VERSION },
    {
      instructions:
        "Read-only access to one Obsidian vault. Use `search` to find notes, `read_note` to open one, " +
        "`backlinks` and `outgoing_links` to follow [[links]], and `list_notes` to browse by folder or #tag. " +
        "Paths are vault-relative with forward slashes.",
    },
  );

  const run = <A>(fn: (args: A) => unknown) => async (args: A) => {
    try {
      await vault.refresh();
      const result = fn(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof VaultError ? err.message : `Unexpected error: ${(err as Error).message}`;
      return { isError: true, content: [{ type: "text" as const, text: message }] };
    }
  };

  server.registerTool(
    "search",
    {
      title: "Search notes",
      description:
        "Full-text, case-insensitive search across all notes, ranked by relevance (BM25 plus title and alias boosts). " +
        'All words must match. Use "quotes" for a phrase and #tag to filter by tag (frontmatter or inline, nested tags included). ' +
        "Returns path, title, tags and up to 3 matching lines with 1-based line numbers per note.",
      inputSchema: {
        query: z.string().min(1).describe('Words, "exact phrase" and/or #tag, e.g. `budget "q3 plan" #work`.'),
        limit: z.number().int().min(1).max(LIMITS.searchMax).optional().describe(`Max results (default ${LIMITS.searchDefault}).`),
        folder: z.string().optional().describe("Only search inside this vault folder."),
        tag: z.string().optional().describe("Only notes with this tag (with or without #)."),
      },
      annotations: { title: "Search notes", ...READ_ONLY },
    },
    run((a: { query: string; limit?: number; folder?: string; tag?: string }) => search(vault, a)),
  );

  server.registerTool(
    "read_note",
    {
      title: "Read a note",
      description:
        "Read one note by path, title or alias. Returns parsed frontmatter, tags, aliases and the body " +
        `(capped at max_chars, default ${LIMITS.readDefaultChars}). If several notes share a title, the shortest path wins and the rest are listed in otherMatches.`,
      inputSchema: {
        note: noteArg,
        max_chars: z.number().int().min(1).max(LIMITS.readMaxChars).optional().describe("Maximum body characters to return."),
      },
      annotations: { title: "Read a note", ...READ_ONLY },
    },
    run((a: { note: string; max_chars?: number }) => readNote(vault, { note: a.note, maxChars: a.max_chars })),
  );

  server.registerTool(
    "backlinks",
    {
      title: "Backlinks",
      description:
        "Notes that link to the given note, with line numbers and context. Counts [[Note]], [[Note|alias]], [[Note#Heading]], " +
        "![[Note]] embeds, Markdown links [text](Note.md) and links inside frontmatter properties.",
      inputSchema: {
        note: noteArg,
        limit: z.number().int().min(1).max(LIMITS.linksMax).optional().describe(`Max source notes (default ${LIMITS.linksDefault}).`),
      },
      annotations: { title: "Backlinks", ...READ_ONLY },
    },
    run((a: { note: string; limit?: number }) => backlinks(vault, a)),
  );

  server.registerTool(
    "outgoing_links",
    {
      title: "Outgoing links",
      description:
        "Links from the given note, each marked as resolved (to a note or attachment path) or unresolved, " +
        "with heading/block subpath, alias, embed flag and line number.",
      inputSchema: { note: noteArg },
      annotations: { title: "Outgoing links", ...READ_ONLY },
    },
    run((a: { note: string }) => outgoingLinks(vault, a)),
  );

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description:
        "List notes sorted by path, optionally filtered by folder (recursive) and tag (case-insensitive, nested tags included).",
      inputSchema: {
        folder: z.string().optional().describe('Vault folder, e.g. "Projects".'),
        tag: z.string().optional().describe('Tag with or without #, e.g. "project" also matches "project/alpha".'),
        limit: z.number().int().min(1).max(LIMITS.listMax).optional().describe(`Max notes (default ${LIMITS.listDefault}).`),
      },
      annotations: { title: "List notes", ...READ_ONLY },
    },
    run((a: { folder?: string; tag?: string; limit?: number }) => listNotes(vault, a)),
  );

  return server;
}
