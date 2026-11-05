import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "data");
export const auditPath = join(dataDir, "audit.jsonl");

export type AuditEntry = {
  ts: string;
  layer: "extension" | "api";
  userId: string;
  userName: string;
  decision: "allow" | "blocked" | "error";
  kind?: string;
  tool: string;
  limit?: number;
  conditions?: string;
  matchedRows?: number;
  durationMs?: number;
  reason?: string;
};

export function appendAudit(entry: Omit<AuditEntry, "ts"> & { ts?: string }) {
  mkdirSync(dataDir, { recursive: true });
  const line: AuditEntry = { ts: entry.ts ?? new Date().toISOString(), ...entry };
  appendFileSync(auditPath, `${JSON.stringify(line)}\n`);
  return line;
}

export function readAudit(limit = 30): AuditEntry[] {
  try {
    const lines = readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((line) => JSON.parse(line) as AuditEntry);
  } catch {
    return [];
  }
}
