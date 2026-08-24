// Persistence for pi-git-auto-sync settings.
// CWD-scoped only — per repo, no global/user-wide layer.
// File: <cwd>/.pi/git-auto-sync.json — written by /git-sync set.
//
// Precedence: built-in defaults < CWD file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GitAutoSyncConfig {
  /** Master switch. Default false. When false: no polling, no startup sync. */
  enabled?: boolean;
  /** Fetch + fast-forward on session start. Default true. */
  startupSync?: boolean;
  /** How long the repo may stay dirty before an auto-sync is triggered. Default 30 min. */
  idleMs?: number;
  /** Poll interval. Default 10 s. */
  pollMs?: number;
}

export const DEFAULTS: Required<GitAutoSyncConfig> = {
  enabled: false,
  startupSync: true,
  idleMs: 30 * 60 * 1000,
  pollMs: 10_000,
};

/** Guards so a mistyped value can't spam the agent or hammer git. */
export const MIN_IDLE_MS = 60_000;
export const MIN_POLL_MS = 1_000;

const FILE = "git-auto-sync.json";

const MS_PER: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

/** Parse a human duration ("45m", "15s", "2h") or a raw millisecond count. null if invalid. */
export function parseDuration(value: string | number): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  }
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(value.trim().toLowerCase());
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2] ?? "ms";
  if (!Number.isFinite(n) || n <= 0) return null;
  return unit === "ms" ? Math.round(n) : Math.round(n * MS_PER[unit]);
}

function sanitize(raw: unknown): GitAutoSyncConfig {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: GitAutoSyncConfig = {};
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  if (typeof r.startupSync === "boolean") out.startupSync = r.startupSync;
  for (const key of ["idleMs", "pollMs"] as const) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[key] = Math.round(v);
  }
  return out;
}

function read(path: string): GitAutoSyncConfig {
  if (!existsSync(path)) return {};
  try {
    return sanitize(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[git-auto-sync] Ignoring malformed settings at ${path}: ${reason}`);
    return {};
  }
}

/** Effective config: built-in defaults < CWD file. */
export function loadConfig(cwd: string): Required<GitAutoSyncConfig> {
  return { ...DEFAULTS, ...read(join(cwd, ".pi", FILE)) };
}


export function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", FILE);
}

/**
 * Merge `patch` onto the existing project file (so unrelated keys survive) and write it.
 * Returns false on IO failure so the caller can surface a "session only" toast.
 */
export function saveConfig(cwd: string, patch: GitAutoSyncConfig): boolean {
  const path = projectConfigPath(cwd);
  const next = { ...loadConfig(cwd), ...sanitize(patch) };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}
