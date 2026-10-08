import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Project root (tests run from .test-build/test). */
export const PROJECT_ROOT = path.resolve(here, "..", "..");
export const SAMPLE_VAULT = path.join(PROJECT_ROOT, "examples", "sample-vault");
export const SERVER_ENTRY = path.resolve(here, "..", "src", "index.js");

/** Create a throwaway directory containing `vault/` (and room for files outside it). */
export function makeTempVault(files: Record<string, string>): { base: string; vault: string; cleanup: () => void } {
  const base = mkdtempSync(path.join(os.tmpdir(), "ovmcp-"));
  const vault = path.join(base, "vault");
  mkdirSync(vault);
  for (const [rel, content] of Object.entries(files)) writeFile(vault, rel, content);
  return { base, vault, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
