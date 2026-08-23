# pi-git-auto-sync

Pi extension that auto-syncs a git repo by delegating the git work to the main agent.

The extension is a thin polling layer. It never commits or pushes on a dirty tree — it watches repo state and, when it decides a sync is due, sends the main agent a precise prompt. The agent (with full tool access) fetches, merges `@{u}` with conflict resolution, reviews the diff, writes a conventional commit, and pushes.

## Behavior

- **Startup sync** — on session start: `git fetch origin`; if behind `@{u}` with a clean tree, fast-forward + push happens by itself (no LLM turn, recorded as an informational session message for headless visibility). If the tree is dirty, the merge is handed to the agent.
- **Idle trigger** — when the repo stays dirty for the configured idle window (default 30 min), the agent is asked to sync. New changes reset the window.
- **Force sync** — `/git-sync` asks the agent to sync immediately, even when auto-sync is off.

## Install

```bash
pi install /home/j2y/dev_pi/pi-git-auto-sync   # local path
# or, once published:
pi install npm:pi-git-auto-sync
```

## Config

Three layers, later wins: **built-in defaults < global < project.**

| File | Written by | Purpose |
| --- | --- | --- |
| `~/.pi/agent/git-auto-sync.json` | you, by hand | user-wide defaults |
| `<repo>/.pi/git-auto-sync.json` | `/git-sync set` | per-repo overrides (lives in gitignored `.pi/`) |

```json
{
  "enabled": true,
  "startupSync": true,
  "idleMs": 1800000,
  "pollMs": 10000
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch — off: no polling, no startup sync |
| `startupSync` | `true` | fetch + fast-forward on session start |
| `idleMs` | `1800000` | how long the repo may stay dirty before an auto-sync (min 1 min) |
| `pollMs` | `10000` | poll interval (min 1 s) |

## Commands

```
/git-sync                  force a sync now (works even when off)
/git-sync status           show the effective config
/git-sync on | off         persist + apply the master switch
/git-sync pause | resume   runtime only, not persisted
/git-sync set idle 45m     idle window (45m / 15s / 2h / raw ms)
/git-sync set poll 15s     poll interval
/git-sync set enabled false
/git-sync set startup true
```

## Develop

```bash
npm install
npm run typecheck
npm test
```

Tests mock the pi API and run against temp dirs — they never touch `~/.pi/agent` or any real repo.
