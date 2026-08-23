import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULTS,
  MIN_IDLE_MS,
  MIN_POLL_MS,
  globalConfigPath,
  loadConfig,
  parseDuration,
  projectConfigPath,
  saveConfig,
} from "../src/config";

let cwd: string;
let agentDir: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "gas-cwd-"));
  agentDir = mkdtempSync(join(tmpdir(), "gas-agent-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
});

describe("parseDuration", () => {
  it("parses human units", () => {
    expect(parseDuration("45m")).toBe(45 * 60_000);
    expect(parseDuration("15s")).toBe(15_000);
    expect(parseDuration("2h")).toBe(2 * 3_600_000);
    expect(parseDuration("90")).toBe(90); // bare number = ms
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("1.5m")).toBe(90_000);
  });

  it("passes through raw numbers", () => {
    expect(parseDuration(1_800_000)).toBe(1_800_000);
  });

  it("rejects garbage", () => {
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("0m")).toBeNull();
    expect(parseDuration("-5")).toBeNull();
    expect(parseDuration(-5)).toBeNull();
    expect(parseDuration(NaN)).toBeNull();
    expect(parseDuration("m")).toBeNull();
  });
});

describe("loadConfig", () => {
  it("falls back to built-in defaults", () => {
    expect(loadConfig(cwd, agentDir)).toEqual(DEFAULTS);
  });

  it("global file overrides defaults", () => {
    writeFileSync(join(agentDir, "git-auto-sync.json"), JSON.stringify({ idleMs: 600_000 }));
    const cfg = loadConfig(cwd, agentDir);
    expect(cfg.idleMs).toBe(600_000);
    expect(cfg.pollMs).toBe(DEFAULTS.pollMs);
  });

  it("project file overrides global", () => {
    writeFileSync(join(agentDir, "git-auto-sync.json"), JSON.stringify({ idleMs: 600_000, enabled: false }));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "git-auto-sync.json"), JSON.stringify({ idleMs: 300_000 }));
    const cfg = loadConfig(cwd, agentDir);
    expect(cfg.idleMs).toBe(300_000);
    expect(cfg.enabled).toBe(false); // global key still applies
  });

  it("skips malformed files without throwing", () => {
    writeFileSync(join(agentDir, "git-auto-sync.json"), "{ not json");
    const cfg = loadConfig(cwd, agentDir);
    expect(cfg).toEqual(DEFAULTS);
  });

  it("drops unknown keys and wrong types", () => {
    writeFileSync(
      join(agentDir, "git-auto-sync.json"),
      JSON.stringify({ enabled: "yes", idleMs: "30m", pollMs: -1, bogus: 42 }),
    );
    const cfg = loadConfig(cwd, agentDir);
    expect(cfg).toEqual(DEFAULTS);
  });
});

describe("saveConfig", () => {
  it("writes the project file, merging over existing keys", () => {
    saveConfig(cwd, { idleMs: 90_000 });
    saveConfig(cwd, { pollMs: 15_000 });
    const written = JSON.parse(readFileSync(join(cwd, ".pi", "git-auto-sync.json"), "utf-8"));
    expect(written).toEqual({ ...DEFAULTS, idleMs: 90_000, pollMs: 15_000 });
  });

  it("creates .pi/ if missing", () => {
    expect(saveConfig(cwd, { enabled: false })).toBe(true);
    const cfg = loadConfig(cwd, agentDir);
    expect(cfg.enabled).toBe(false);
  });

  it("returns false when the path is not writable", () => {
    // A regular file blocks creation of the .pi/ directory underneath it.
    const blocked = join(cwd, "blocked");
    writeFileSync(blocked, "not a dir");
    expect(saveConfig(blocked, { enabled: false })).toBe(false);
  });

  it("exposes stable paths", () => {
    expect(globalConfigPath(agentDir)).toBe(join(agentDir, "git-auto-sync.json"));
    expect(projectConfigPath(cwd)).toBe(join(cwd, ".pi", "git-auto-sync.json"));
  });
});

describe("guards", () => {
  it("publish sane minimums", () => {
    expect(MIN_IDLE_MS).toBe(60_000);
    expect(MIN_POLL_MS).toBe(1_000);
  });
});
