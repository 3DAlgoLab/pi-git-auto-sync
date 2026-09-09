# Handoff — remote-aware periodic sync (not yet built)

Owner: 오빠. Written by Ava. Repo: `~/dev_pi/pi-git-auto-sync`, v1.1.0, git clean, HEAD == origin/main.
Read this before touching `src/`. Nothing below is implemented; it is a spec + checklist.

## 0. Mission

A "maintainer" agent runs pi headless (no UI, no direct user interaction). It must notice that the
remote moved and pull/merge it in — **silently**, without disturbing whatever the agent or a human
is doing.

Owner's requirements, in his words:

1. Periodic checking is needed. Its interval should be adjustable like other parameters.
2. Fetch, pull & merge should happen in real idle time (when she is doing nothing really).
3. "Idle" needs a confirmation wait: right after an idle flag turns on, the user may interact at
   any moment. Wait before acting.

Target user: a headless pi agent, not a human at a terminal. Optimize for that case.

## 1. Current state (verified, v1.1.0)

`src/git-auto-sync.ts` (451 lines) — all anchors are real function starts:

| line | symbol | what it does |
| --- | --- | --- |
| 131 | `record` | `piApi.sendUserMessage` with an "informational, no git work requested" trailer |
| 144 | `triggerSync` | injects the full commit+push instruction prompt into the main agent |
| 166 | `startupSync` | `git fetch` + `rev-list --count HEAD..@{u}` (behind count) + merge; ff-only when clean, ask-to-merge when dirty |
| 221 | `tick` | the periodic loop |
| 280 / 285 / 291 | `go` / `restartPolling` / `halt` | timer control (`setInterval(tick, cfg.pollMs)`) |
| 303 / 312 | `statusText` / `applySet` | `/gitautosync status`, `... set idle | poll | enabled | startup` |

Subcommands at ~417: `status · on · off · pause · resume · set`. **There is no `now` / `sync` command.**

Config: `enabled`, `startupSync`, `idleMs`, `pollMs`. Clamped by `MIN_IDLE_MS` / `MIN_POLL_MS`
(`src/config.ts`), durations parsed by `parseDuration` (`45m`, `15s`, `2h`, raw ms). Per-project
config file; `saveConfig` failure degrades to session-only with a warning.

Tests: `test/config.test.ts` (13 cases), `test/sync.test.ts` (16 cases).
Scripts: `npm run typecheck` (tsc --noEmit) · `npm run test` (vitest run) · `npm run build`.

### The gap, stated exactly

- **`tick()` never touches the network.** It runs `git status --porcelain` and nothing else. Remote
  movement is invisible after the first `startupSync()`.
- **`idleMs` does not mean agent idle.** It measures *dirty age*: `dirtyAt` is set when the changed
  file *paths* stop changing (`prevPaths` set-diff at ~238). A silent agent with a dirty tree looks
  "idle" to this code; a busy agent with a clean tree looks idle too. It is a debounce for
  commit-prompt spam, not an idleness detector.
- **Consequence:** wiring a merge into today's `tick()` would merge mid-turn. That is the bug to
  avoid, and why req (2) and (3) need a real idle gate, not `idleMs` reuse.
- `pause` / `resume` already exist — reuse them as the manual escape hatch.

## 2. Design: two clocks, one gate

```text
pollMs  (cheap clock)   git status  -> dirty-debounce -> triggerSync (commit+push)   [exists]
fetchMs (new, cheap)    git fetch   -> behind count -> REMOTE_PENDING flag           [to build]
idle gate (new)         busy? + confirmed-idle?      -> consume flag -> merge         [to build]
```

Rules:

- **Fetch is cheap and non-mutating.** It may run on a timer regardless of busy state. It sets a
  flag; it never merges, never opens a modal, never injects a prompt.
- **Merge only inside the gate.** Gate open = agent has been idle for `idleConfirmMs` continuous.
- Any activity while the flag is pending keeps the flag pending. Nothing is lost; merge lands on
  the first open gate.

### Idle state machine (the new part)

pi has **no idle event** (verified earlier via `pi event list`; re-verify against the installed
version before coding). Derive it:

```text
busy = true   on turn/agent start event
busy = false  on turn/agent end event
idleSince = Date.now()   at the busy->idle flip
gateOpen = !busy && (now - idleSince >= idleConfirmMs)
```

- `idleSince = 0` means busy. Reset `idleSince` to 0 on any start event.
- Do not treat "no events seen yet" as idle-with-a-timer; default to busy until the first end event.
- Headless caveat: if the harness never fires end events, the gate never opens. Detect that and
  fall back to `startupSync` behaviour + a warning in `statusText`, not a silent never-sync.

### Behind classification (reuse `startupSync` logic, do not fork it)

Extract the behind/merge decision from `startupSync` (line 166) into a shared function used by both
startup and the gate. Branches to keep distinct:

| state | action |
| --- | --- |
| behind, tree clean, no divergence | `git merge --ff-only @{u}` — silent, `record()` after |
| behind + local unpushed (diverged) | do not merge silently; `triggerSync`-style prompt |
| behind, tree dirty | defer (flag stays pending), `display()` the count |
| fetch fails / no upstream | `display()` once, do not spam |

## 3. Config additions (follow existing pattern exactly)

| key | default | min | meaning |
| --- | --- | --- | --- |
| `remoteSync` | on | — | master switch for fetch+merge on the gate |
| `fetchMs` | 60s | 15s | how often to ask the remote (req 1: adjustable like the others) |
| `idleConfirmMs` | 10s | 5s | quiet period after busy->idle before merging (req 3) |

Add to `DEFAULTS` and `clampConfig` in `src/config.ts`, to `applySet` (`key === "fetch"` etc. — the
`idle|poll` branch at 326 is the template), to `statusText`, and to the README config table.

## 4. TODO

- [ ] `src/config.ts`: add `remoteSync`, `fetchMs`, `idleConfirmMs` + clamps + parse.
      verify: `test/config.test.ts` cases for each clamp; `npm run test`
- [ ] Extract behind/merge decision out of `startupSync` into one shared function.
      verify: existing 16 `test/sync.test.ts` cases still pass, unchanged
- [ ] New fetch clock in `tick()` (or a second interval): `git fetch --quiet origin` then
      `rev-list --count HEAD..@{u}`; set `remotePending = {count}` only.
      verify: test with a stubbed `execFn` asserting fetch happens and **no merge command runs**
- [ ] Idle gate: busy flag from start/end events + `idleSince` + `idleConfirmMs`.
      verify: unit test — start, end, confirm<window -> no merge; confirm>=window -> exactly one merge
- [ ] Consume `remotePending` on gate open; recompute behind count at consume time (stale flag guard).
      verify: test — flag set, then remote moves back / ff becomes impossible -> no blind merge
- [ ] `busy` must also block `triggerSync` re-arming, and `halt()`/`pause` must clear flag + `idleSince`.
      verify: tests for both
- [ ] `/gitautosync now` — force one fetch+evaluate pass (useful for testing and for the maintainer).
      verify: `statusText` shows pending count; command test
- [ ] Headless fallback when no end events exist → warning in `statusText`, never a silent no-op.
- [ ] README: config table + a "maintainer / headless agent" section. Note merge is silent by design.
- [ ] Bump version, commit, push — per-harness extension update is automatic from here.

## 5. Traps (each one already cost time this session)

- **`ctx.ui.select` blocks the event loop.** A timer callback that calls it freezes pi until someone
  answers in a UI that a headless agent does not have. `ctx.ui.notify` is non-blocking — use notify
  or `record()`. Never a modal on a timer.
- **No `ctx.sleep`.** Long waits are callbacks/timers only.
- **Never merge on a timer without the gate.** Merging mid-turn rewrites files under a running agent.
- **Never `git add -A` / commit while a test sandbox has a dirty real repo.** Use a disposable
  `/tmp` repo in tests.
- **Anchor staleness:** `replace` anchors die when the file drifts. One edit per turn, check the
  diff, re-`read` when in doubt (`[E_STALE_ANCHOR]`).
- **`anchor_grep` rejects some regexes** (`[E_UNSAFE_REGEX]`). Split patterns instead of fighting it.
- **repl stdout is capped ~4K chars.** Keep results in REPL vars; never print bulk file text.
- `git -C` against a `/tmp` sandbox may hit permission limits — check before assuming a bug.
- Repo is the single source of truth: edit here, push, harnesses update themselves. Do not maintain
  copies elsewhere.

## 6. Open questions for 오빠

1. Merge with local unpushed commits (diverged): auto-rebase, or always ask? Current code asks.
2. Should the merge itself be a `git merge --ff-only` only, or is a real merge commit acceptable?
3. Default `fetchMs` — 60s for a maintainer agent, or faster?
4. Should `remoteSync` default to on for existing installs, or stay off until opted in?
