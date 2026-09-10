#!/usr/bin/env node
// Standalone auto pull/push for local-only repos (no pi extension needed).
//
// The pi extension deliberately skips startup sync for repos without a remote
// upstream. This script covers those: a background daemon that fetches,
// fast-forwards, and pushes — stashing local changes around the pull.
//
// Usage:
//   node scripts/auto-pull.mjs <repo> start      # run as a detached background daemon
//   node scripts/auto-pull.mjs <repo> stop       # stop the daemon
//   node scripts/auto-pull.mjs <repo> status     # running? last action? recent log?
//   node scripts/auto-pull.mjs <repo> run-once   # one sync cycle (for cron)
//   node scripts/auto-pull.mjs <repo> loop       # foreground loop (default)
//
// Interval: $AUTO_PULL_EVERY seconds (default 60).
// State (all inside <repo>/.git so git status stays clean):
//   git-auto-sync.pull        last cycle result (JSON)
//   git-auto-sync.pull.pid    daemon pid (while running)
//   git-auto-sync.pull.log    append-only log (trimmed at ~200 KB)

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [,, repoArg, command = "loop", ...rest] = process.argv;
if (!repoArg) {
  console.error("usage: auto-pull.mjs <repo> [start|stop|status|run-once|loop]");
  process.exit(2);
}
const repo = resolve(repoArg);
const gitDir = join(repo, ".git");
const STATE = join(gitDir, "git-auto-sync.pull");
const PIDF = join(gitDir, "git-auto-sync.pull.pid");
const LOGF = join(gitDir, "git-auto-sync.pull.log");
const EVERY_MS = Math.max(5, Number.parseInt(process.env.AUTO_PULL_EVERY ?? "60", 10) || 60) * 1000;
const SELF = fileURLToPath(import.meta.url);

function git(args, timeoutMs = 30_000) {
  try {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8", timeout: timeoutMs });
    return {
      code: r.status ?? -1,
      out: `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim(),
    };
  } catch (err) {
    return { code: -1, out: err instanceof Error ? err.message : String(err) };
  }
}

function count(from, to) {
  const r = git(["rev-list", "--count", `${from}..${to}`]);
  return r.code === 0 ? Number.parseInt(r.out, 10) : NaN;
}

function log(msg) {
  try {
    const next = `[${new Date().toISOString()}] ${msg}\n`;
    if (existsSync(LOGF) && statSync(LOGF).size > 200_000) writeFileSync(LOGF, "", "utf-8");
    appendFileSync(LOGF, next, "utf-8");
  } catch {
    /* logging must never kill the daemon */
  }
}

function notify(title) {
  try {
    const r = spawnSync("notify-send", [title], { encoding: "utf-8", timeout: 3_000 });
    if (r.status !== 0 && r.error) {
      spawnSync("osascript", ["-e", `display notification "${title}"`], { encoding: "utf-8", timeout: 3_000 });
    }
  } catch {
    /* notifications are best-effort */
  }
}

function writeState(obj) {
  try {
    writeFileSync(STATE, JSON.stringify({ ts: new Date().toISOString(), ...obj }, null, 2) + "\n", "utf-8");
  } catch {
    /* best-effort */
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function daemonPid() {
  if (!existsSync(PIDF)) return null;
  const pid = Number.parseInt(readFileSync(PIDF, "utf-8").trim(), 10);
  return Number.isFinite(pid) && pidAlive(pid) ? pid : null;
}

/** One sync cycle: fetch -> fast-forward -> push -> unstash. */
function cycle() {
  if (!existsSync(gitDir)) {
    log(`no .git at ${repo}`);
    return;
  }
  if (git(["rev-parse", "--verify", "--quiet", "@{u}"]).code !== 0) {
    writeState({ action: "no-upstream" });
    return;
  }
  const fetch = git(["fetch", "origin", "--quiet"]);
  if (fetch.code !== 0) {
    log(`fetch failed: ${fetch.out.slice(0, 200)}`);
    writeState({ action: "fetch-failed", detail: fetch.out.slice(0, 200) });
    return;
  }
  const behind = count("HEAD", "@{u}");
  if (behind === 0) {
    const ahead = count("@{u}", "HEAD");
    if (ahead > 0) {
      const push = git(["push"]);
      if (push.code !== 0) {
        log(`push failed: ${push.out.slice(0, 200)}`);
        writeState({ action: "push-failed", detail: push.out.slice(0, 200) });
        return;
      }
      log(`pushed ${ahead} commit(s) to origin`);
      writeState({ action: "pushed", ahead });
      notify(`git auto-sync: pushed ${ahead} commit(s) to origin`);
      return;
    }
    log("up to date");
    writeState({ action: "up-to-date" });
    return;
  }

  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).out;
  let stashed = false;
  if (dirty) {
    const stash = git(["stash", "push", "-m", `git-auto-sync ${new Date().toISOString()}`]);
    if (stash.code !== 0) {
      log(`stash failed, skipping cycle: ${stash.out.slice(0, 200)}`);
      writeState({ action: "stash-failed" });
      return;
    }
    stashed = true;
  }

  const merge = git(["merge", "--ff-only", "@{u}"]);
  if (merge.code !== 0) {
    if (stashed) git(["stash", "pop"]);
    log(`fast-forward failed (local and remote diverged? manual merge needed): ${merge.out.slice(0, 200)}`);
    writeState({ action: "merge-failed", detail: merge.out.slice(0, 200) });
    notify("git auto-sync: pull failed, manual merge needed");
    return;
  }

  const ahead = count("@{u}", "HEAD");
  let pushed = 0;
  if (ahead > 0) {
    const push = git(["push", "origin", "HEAD"], 60_000);
    if (push.code === 0) pushed = ahead;
    else log(`push failed: ${push.out.slice(0, 200)}`);
  }

  let unstashFailed = false;
  if (stashed) {
    const pop = git(["stash", "pop"]);
    if (pop.code !== 0) {
      unstashFailed = true;
      log("stash pop conflicted — local changes left in `git stash`");
    }
  }

  log(`pulled ${behind} commit(s), pushed ${pushed === 0 ? "none" : `${pushed} commit(s)`}${unstashFailed ? ", UNSTASH CONFLICT" : ""}`);
  writeState({ action: "pulled", behind, pushed, unstashFailed });
  notify(`git auto-sync: pulled ${behind} commit(s)`);
}

function runLoop() {
  log(`daemon started (pid ${process.pid}, every ${EVERY_MS / 1000}s)`);
  if (rest.includes("--daemon")) {
    try {
      mkdirSync(gitDir, { recursive: true });
      writeFileSync(PIDF, String(process.pid), "utf-8");
    } catch {
      /* best-effort */
    }
  }
  cycle();
  const id = setInterval(cycle, EVERY_MS);
  const shutdown = () => {
    clearInterval(id);
    try {
      if (existsSync(PIDF) && Number.parseInt(readFileSync(PIDF, "utf-8").trim(), 10) === process.pid) unlinkSync(PIDF);
    } catch {
      /* best-effort */
    }
    log("daemon stopped");
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

switch (command) {
  case "start": {
    const existing = daemonPid();
    if (existing) {
      console.log(`already running (pid ${existing})`);
      break;
    }
    const child = spawn(process.execPath, [SELF, repo, "loop", "--daemon"], { detached: true, stdio: "ignore" });
    child.unref();
    console.log(`started daemon (pid ${child.pid}), every ${EVERY_MS / 1000}s`);
    break;
  }
  case "stop": {
    const pid = daemonPid();
    if (!pid) {
      console.log("not running");
      break;
    }
    process.kill(pid, "SIGTERM");
    console.log(`stopped (pid ${pid})`);
    break;
  }
  case "status": {
    const pid = daemonPid();
    console.log(`daemon: ${pid ? `running (pid ${pid})` : "not running"}`);
    console.log(`repo:   ${repo}`);
    if (existsSync(STATE)) {
      console.log(`last:   ${readFileSync(STATE, "utf-8").trim()}`);
    }
    if (existsSync(LOGF)) {
      console.log("log tail:");
      console.log(readFileSync(LOGF, "utf-8").trim().split("\n").slice(-5).join("\n"));
    }
    break;
  }
  case "run-once":
    cycle();
    break;
  case "loop":
    runLoop();
    break;
  default:
    console.error(`unknown command: ${command} (use start|stop|status|run-once|loop)`);
    process.exit(2);
}
