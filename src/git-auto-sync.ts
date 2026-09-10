/**
 * Git Auto-Sync (pi package)
 *
 * Thin polling layer that monitors repo state and delegates git work to the
 * main agent (which has full tool access — read, bash, write, edit).
 *
 * On session start it fetches origin and, if behind @{u}, fast-forwards a
 * clean tree by itself or hands the merge to the main agent.
 *
 * When the repo stays dirty for the configured idle window, the extension
 * crafts a prompt and sends it via `sendUserMessage()`. The main agent then:
 *   1. Fetches origin
 *   2. Merges @{u} (resolving conflicts with full context)
 *   3. Reviews the diff
 *   4. Generates a conventional commit message
 *   5. Stages, commits, pushes
 *
 * Config (see config.ts) — CWD-scoped, per repo: built-in defaults < CWD file:
 *   <cwd>/.pi/git-auto-sync.json   (written by /git-sync set)
 *   keys:    enabled, startupSync, idleMs, pollMs
 *
 * Commands:
 *   /git-sync                 force a sync now (works even when disabled)
 *   /git-sync status          show the effective config
 *   /git-sync on | off        persist + apply the master switch
 *   /git-sync pause | resume  runtime only, not persisted
 *   /git-sync set idle 45m    persist idle window   (45m / 15s / 2h / raw ms)
 *   /git-sync set poll 15s    persist poll interval (min 1s)
 *   /git-sync set enabled false
 *   /git-sync set startup true
 *
 * Headless-safe visibility: the status line is only visible while a TUI is
 * attached, so lifecycle events that matter without a terminal — startup
 * fast-forward pull — are ALSO recorded as session user messages (via
 * `record()`). Those messages are explicitly marked informational.
 *
 * Brand-aware display: pi and prime-agent are different TUIs. pi renders
 * the extension footer (setStatus); prime-agent's TUI hides the footer, so
 * there the status is shown as a widget above the editor (setWidget).
 * The hosting agent is detected at session start (see detectBrand()).
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULTS,
  MIN_IDLE_MS,
  MIN_POLL_MS,
  type GitAutoSyncConfig,
  loadConfig,
  parseDuration,
  projectConfigPath,
  saveConfig,
} from "./config";

type Cfg = Required<GitAutoSyncConfig>;

let timer: ReturnType<typeof setInterval> | null = null;
let gCtx: ExtensionContext | null = null;
let cfg: Cfg = { ...DEFAULTS };
let dirtyAt = 0;
let dirty = false;
let busy = false;
let prevPaths: Set<string> = new Set();
let piApi: ExtensionAPI | null = null;
let startupDone = false; // tick must not clobber the footer while startup sync runs
let execFn: (cmd: string, args: string[], options?: { timeout?: number }) => Promise<{
  stdout: string;
  stderr?: string;
  code: number;
}>;

type Brand = "pi" | "prime-agent" | "unknown";
let brand: Brand = "unknown";

/**
 * Detect which coding agent hosts this extension so the status can use a
 * surface that is actually visible in that TUI:
 *   pi          -> footer (setStatus)
 *   prime-agent -> widget (setWidget) — its TUI hides the footer
 * Both hosts set process.title from their own package.json piConfig.name at
 * startup ("pi" / "pi-rpc" vs "prime-agent"). If the title is missing or
 * was overwritten, fall back to the host loader path in the call stack.
 */
function detectBrand(): Brand {
  const t = typeof process.title === "string" ? process.title : "";
  if (t.startsWith("prime-agent")) return "prime-agent";
  if (t === "pi" || t === "pi-rpc") return "pi";
  try {
    const stack = new Error().stack ?? "";
    if (stack.includes("prime-agent/dist")) return "prime-agent";
    if (stack.includes("pi-coding-agent/dist")) return "pi";
  } catch {
    /* non-fatal — fall through to unknown */
  }
  return "unknown";
}

/** Brand-aware status line: widget on prime-agent, footer on pi. */
function display(text: string) {
  if (!gCtx?.hasUI) return;
  const ui = gCtx.ui;
  // Unknown host (tests, future brands): prefer the widget if the runtime
  // exposes it, otherwise fall back to the footer.
  const useWidget =
    brand === "prime-agent" || (brand === "unknown" && typeof ui.setWidget === "function");
  if (useWidget) ui.setWidget("git-sync", [`git-sync: ${text}`]);
  else ui.setStatus("git-sync", text);
}

function toast(msg: string, kind: "info" | "warning" | "error" = "info") {
  if (gCtx?.hasUI) gCtx.ui.notify(msg, kind);
}

function humanDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms >= 1000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms)} ms`;
}

/**
 * Persistent, headless-safe visibility: record an event as a session user
 * message so it shows up in the transcript even when no TUI was attached.
 * The message tells the agent it is informational unless it says otherwise.
 */
function record(msg: string) {
  if (!piApi) return;
  piApi.sendUserMessage(
    `[git-auto-sync] ${msg} (informational — no git work requested unless the message says otherwise)`,
  );
}

function reload() {
  if (!gCtx) return;
  cfg = loadConfig(gCtx.cwd);
}

/* ---------- trigger main agent ---------- */
function triggerSync(count: number) {
  if (!piApi) return;

  const prompt = [
    `[git-auto-sync] Repo has been dirty for ${humanDuration(cfg.idleMs)} or more.`,
    `${count} file(s) changed.`,
    "",
    "Please perform git sync:",
    "1. `git fetch origin`",
    "2. `git merge @{u}` — if conflicts exist, resolve them by reading full conflicted files and choosing the correct code",
    "3. `git status --short` and `git diff --stat` to review ALL changes (including untracked new files)",
    "4. Generate a conventional commit message, stage all changes (git add -A or specific paths), commit + push",
    "5. If push fails because remote advanced: fetch + merge + retry push",
    "",
    "Skip if there are no local changes remaining. Run all commands relative to the repo root.",
  ].join("\n");

  piApi.sendUserMessage(prompt);
  toast(`Triggered git sync (${count} file(s))`, "info");
}

/* ---------- startup sync with remote ---------- */
/**
 * True when any configured remote actually has a reachable HEAD ref.
 * Catches two failure shapes: no remote configured, and a configured but
 * empty/dead remote (e.g. a Gitea repo deleted and re-created upstream —
 * the remote URL is still in .git/config but 404s).
 * Local-only repos return false, so the startup sync silently skips them.
 */
async function hasRemoteUpstream(): Promise<boolean> {
  const inside = await execFn("git", ["rev-parse", "--is-inside-work-tree"], { timeout: 10_000 });
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return false;
  const remotes = await execFn("git", ["remote"], { timeout: 10_000 });
  for (const name of remotes.stdout.trim().split("\n").filter(Boolean)) {
    const probe = await execFn("git", ["ls-remote", "--exit-code", name, "HEAD"], { timeout: 30_000 });
    if (probe.exitCode === 0) return true;
  }
  return false;
}

async function startupSync() {
  display("fetching origin...");

  const fetch = await execFn("git", ["fetch", "origin"], { timeout: 60_000 });
  if (fetch.code !== 0) {
    display("fetch failed");
    toast("git-auto-sync: fetch failed", "warning");
    return;
  }

  const behind = await execFn("git", ["rev-list", "--count", "HEAD..@{u}"]);
  if (behind.code !== 0) {
    display("up to date");
    return;
  }
  const n = parseInt(behind.stdout.trim(), 10) || 0;
  if (n === 0) {
    // Local is up to date: make sure the remote is, too. Local may hold
    // commits from an earlier manual sync that were never pushed — that
    // state blocks every future fast-forward pull (the same deadlock the
    // idle-sync path resolves). Push before declaring victory.
    if (await autoPull()) {
      display("synced with origin");
      record("On startup, local was up to date with origin; pushed pending local commit(s) so future fast-forward pulls are unblocked.");
    } else {
      display("up to date");
    }
    return;
  }

  // Clean tree: fast-forward + push by ourselves, no LLM turn needed
  const status = await execFn("git", ["status", "--porcelain"]);
  const clean = status.code === 0 && status.stdout.trim().length === 0;
  if (clean) {
    const merge = await execFn("git", ["merge", "--ff-only", "@{u}", "--no-edit"], { timeout: 60_000 });
    if (merge.code === 0) {
      const push = await execFn("git", ["push"], { timeout: 60_000 });
      display(`synced: +${n} commit(s) from origin`);
      toast(`git-auto-sync: pulled ${n} commit(s)${push.code === 0 ? ", pushed" : ""}`, "info");
      // Headless-safe record: this pull happened without anyone watching.
      record(
        `On startup, local was behind origin by ${n} commit(s); fast-forwarded` +
          `${push.code === 0 ? " and pushed" : ""}. Nothing further is needed.`,
      );
      return;
    }
  }
  // Dirty tree or non-FF merge: main agent handles it
  display(`behind origin by ${n}, asking agent...`);
  piApi?.sendUserMessage(
    [
      "[git-auto-sync] On startup, local is behind origin by",
      `${n} commit(s). Please sync with the remote:`,
      "",
      "1. `git fetch origin`",
      "2. `git merge @{u}` — if conflicts exist, resolve them by reading full conflicted files and choosing the correct code",
      "3. If the tree was dirty, commit the local changes first (conventional message), then merge",
      "4. `git push` when the merge is complete",
    ].join("\n"),
  );
  toast(`git-auto-sync: asked agent to pull ${n} commit(s)`, "info");
}

/**
 * Push local commits that the remote is missing. Startup's fetch only
 * reconciles one direction (remote -> local); if a local commit never made
 * it to origin, the next startup can't fast-forward and the idle-sync path
 * deadlocks (idle merge refuses to commit while behind, pull refuses to
 * merge a dirty tree, commit refuses while behind).
 * Returns true when something was pushed, false when already in sync (or
 * when the push failed — reported via toast, no exception thrown).
 */
async function autoPull(): Promise<boolean> {
  const ahead = await execFn("git", ["rev-list", "--count", "@{u}..HEAD"]);
  if (ahead.code !== 0) return false;
  const k = parseInt(ahead.stdout.trim(), 10) || 0;
  if (k === 0) return false;

  const dirty = await execFn("git", ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.code !== 0 || dirty.stdout.trim().length > 0) return false;

  const push = await execFn("git", ["push"], { timeout: 60_000 });
  if (push.code !== 0) {
    toast(`git-auto-sync: local push failed — ${push.stderr.slice(0, 160)}`.trim(), "warning");
    return false;
  }
  toast(`git-auto-sync: pushed ${k} local commit(s) to origin`, "info");
  return true;
}

/* ---------- poll tick ---------- */
async function tick() {
  if (busy) return;
  busy = true;

  try {
    const { stdout, code } = await execFn("git", ["status", "--porcelain"]);
    if (code !== 0) {
      dirty = false;
      dirtyAt = 0;
      prevPaths.clear();
      if (startupDone) display("not a repo");
      return;
    }

    const d = stdout.trim().length > 0;
    const count = stdout.trim().split("\n").filter(Boolean).length;

    if (d) {
      const cur = new Set(
        stdout.trim().split("\n").map((l) => l.slice(3)),
      );
      const changed =
        prevPaths.size === 0 ||
        prevPaths.size !== cur.size ||
        [...cur].some((p) => !prevPaths.has(p));
      if (changed) {
        dirtyAt = Date.now();
        dirty = true;
      }
      prevPaths = cur;
    }
    if (!d && dirty) {
      // re-arm: the grace window restarts on the next new change
      dirty = false;
      dirtyAt = 0;
      prevPaths.clear();
      if (startupDone) display("clean");
      return;
    }
    if (!d) {
      if (startupDone) display("clean");
      return;
    }

    const elapsed = Date.now() - dirtyAt;
    const rem = Math.max(0, Math.ceil((cfg.idleMs - elapsed) / 1000));
    if (startupDone) display(`${count} changed, syncing in ${rem}s`);

    if (elapsed >= cfg.idleMs) {
      dirty = false;
      dirtyAt = 0;
      prevPaths.clear();
      triggerSync(count);
    }
  } finally {
    busy = false;
  }
}

/* ---------- start / stop ---------- */
function go() {
  if (timer) return;
  timer = setInterval(tick, cfg.pollMs);
}

function restartPolling() {
  if (timer) clearInterval(timer);
  timer = null;
  if (cfg.enabled) go();
}

function halt() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  dirty = false;
  dirtyAt = 0;
  busy = false;
  prevPaths.clear();
}

/* ---------- commands ---------- */
function statusText(cwd: string): string {
  const surface = brand === "prime-agent" ? "widget" : brand === "pi" ? "footer" : "auto";
  const lines = [
    `git-auto-sync: ${cfg.enabled ? "on" : "off"} · startup: ${cfg.startupSync ? "on" : "off"} · idle: ${humanDuration(cfg.idleMs)} · poll: ${humanDuration(cfg.pollMs)} · host: ${brand} · display: ${surface}`,
    `project config: ${projectConfigPath(cwd)}`,
  ];
  return lines.join("\n");
}

async function applySet(cwd: string, key: string, raw: string, c: ExtensionCommandContext): Promise<void> {
  const note = (msg: string, kind: "info" | "warning" | "error" = "info") => c.ui.notify(msg, kind);

  if (key === "idle" || key === "poll") {
    const ms = parseDuration(raw);
    if (ms === null) {
      note(`Invalid duration: ${raw} (use e.g. 45m, 15s, 2h, or raw ms)`, "error");
      return;
    }
    const min = key === "idle" ? MIN_IDLE_MS : MIN_POLL_MS;
    if (ms < min) {
      note(`${key} must be at least ${humanDuration(min)}`, "error");
      return;
    }
    const patch: GitAutoSyncConfig = key === "idle" ? { idleMs: ms } : { pollMs: ms };
    if (!saveConfig(cwd, patch)) {
      note(`Could not write ${projectConfigPath(cwd)} — applying for this session only`, "warning");
      cfg = { ...cfg, ...patch };
      return;
    }
    reload();
    if (key === "poll") restartPolling();
    note(`git-auto-sync: ${key} = ${humanDuration(cfg[key === "idle" ? "idleMs" : "pollMs"])} (saved)`);
    return;
  }

  if (key === "enabled" || key === "startup") {
    const b = raw === "true" || raw === "1" || raw === "on";
    if (!(raw === "true" || raw === "false" || raw === "1" || raw === "0" || raw === "on" || raw === "off")) {
      note(`Invalid value: ${raw} (use true/false)`, "error");
      return;
    }
    const patch: GitAutoSyncConfig = key === "enabled" ? { enabled: b } : { startupSync: b };
    const saved = saveConfig(cwd, patch);
    cfg = { ...cfg, ...patch };
    if (key === "enabled") {
      if (b) go();
      else halt();
      display(b ? "on" : "disabled");
    }
    note(`git-auto-sync: ${key} = ${b}${saved ? " (saved)" : " (session only)"}`);
  }
}

/* ---------- extension entry ---------- */
export default function (pi: ExtensionAPI) {
  piApi = pi;
  execFn = pi.exec.bind(pi) as typeof execFn;

  pi.on("session_start", async (_ev: SessionStartEvent, c: ExtensionContext) => {
    gCtx = c;
    brand = detectBrand();
    cfg = loadConfig(c.cwd);
    if (!cfg.enabled) {
      startupDone = true;
      display("disabled");
      return;
    }

    go();
    display("waiting for next sync");
    const startSync = cfg.startupSync && (await hasRemoteUpstream());
    if (cfg.startupSync && !startSync) {
      toast("git-auto-sync: no reachable remote upstream — skipped startup sync");
    }
    if (startSync) {
      // Race the sync against a timeout so a hung fetch can't hold the footer forever.
      // Clear the watchdog when the race settles so it never keeps the process alive.
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      Promise.race([
        startupSync(),
        new Promise<void>((r) => {
          watchdog = setTimeout(r, 90_000);
        }),
      ]).finally(() => {
        clearTimeout(watchdog);
        startupDone = true;
      });
    } else {
      startupDone = true;
    }
  });

  pi.on("session_shutdown", async () => {
    if (gCtx?.hasUI && brand === "prime-agent") gCtx.ui.setWidget("git-sync", undefined);
    halt();
    gCtx = null;
  });

  pi.registerCommand("git-sync", {
    description: "Force git sync now, or on/off/pause/resume and configure auto-sync",
    handler: async (args: string, c: ExtensionCommandContext) => {
      const [cmd, key, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const value = rest.join(" ");

      if (!cmd) {
        // Default: force sync now
        const { stdout, code } = await execFn("git", ["status", "--porcelain"]);
        if (code !== 0 || stdout.trim().length === 0) {
          c.ui.notify("No changes to sync", "info");
          return;
        }
        const count = stdout.trim().split("\n").filter(Boolean).length;
        triggerSync(count);
        c.ui.notify("Sync request sent to main agent", "info");
        return;
      }

      switch (cmd) {
        case "status":
          c.ui.notify(statusText(c.cwd), "info");
          return;
        case "on":
          await applySet(c.cwd, "enabled", "true", c);
          return;
        case "off":
          await applySet(c.cwd, "enabled", "false", c);
          return;
        case "pause":
          halt();
          c.ui.notify("Auto-sync paused (runtime only — use /git-sync off to persist)", "info");
          return;
        case "resume":
          if (cfg.enabled) go();
          c.ui.notify("Auto-sync resumed (no-op if /git-sync off was set)", "info");
          return;
        case "set": {
          if (!key || !value) {
            c.ui.notify("Usage: /git-sync set <idle|poll|enabled|startup> <value>", "error");
            return;
          }
          if (!["idle", "poll", "enabled", "startup"].includes(key)) {
            c.ui.notify(`Unknown key: ${key} (use idle, poll, enabled, startup)`, "error");
            return;
          }
          await applySet(c.cwd, key, value, c);
          return;
        }
        default:
          c.ui.notify("Usage: /git-sync [status|on|off|pause|resume|set <key> <value>]", "error");
      }
    },
  });
}
