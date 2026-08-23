import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redirect the global config dir to a temp dir so tests never touch ~/.pi/agent.
const mockState = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => mockState.agentDir,
}));

import gitAutoSync from "../src/git-auto-sync";

/* ---------- fakes ---------- */

interface GitState {
  dirty: boolean;
  behind: number;
}

function makeApi(git: GitState) {
  const calls: string[] = [];
  const messages: string[] = [];
  return {
    calls,
    messages,
    handlers: new Map<string, Array<(ev: unknown, ctx: unknown) => void | Promise<void>>>(),
    commands: new Map<string, { description: string; handler: (args: string, ctx: unknown) => void | Promise<void>() }>(),
    on(ev: string, h: (ev: unknown, ctx: unknown) => void | Promise<void>) {
      const arr = this.handlers.get(ev) ?? [];
      arr.push(h);
      this.handlers.set(ev, arr);
    },
    registerCommand(name: string, def: { description: string; handler: (args: string, ctx: unknown) => void | Promise<void>() }) {
      this.commands.set(name, def);
    },
    sendUserMessage(m: string) {
      messages.push(m);
    },
    exec: async (_cmd: string, args: string[]) => {
      const a = args.join(" ");
      calls.push(a);
      if (a === "status --porcelain") return { code: 0, stdout: git.dirty ? " M notes.md\n?? new.md\n" : "" };
      if (a === "fetch origin") return { code: 0, stdout: "" };
      if (a === "rev-list --count HEAD..@{u}") return { code: 0, stdout: String(git.behind) };
      if (a.startsWith("merge")) return { code: 0, stdout: "" };
      if (a === "push") return { code: 0, stdout: "" };
      return { code: 128, stderr: `unexpected: ${a}` };
    },
  };
}

type Api = ReturnType<typeof makeApi>;

function sessionCtx(cwd: string) {
  let footerText = "";
  return {
    ctx: {
      cwd,
      hasUI: true,
      ui: {
        setStatus: (_key: string, text: string | undefined) => {
          footerText = text ?? "";
        },
        notify: () => {},
      },
    },
    footer: () => footerText,
  };
}

function cmdCtx(cwd: string) {
  const notes: Array<{ msg: string; kind?: string }> = [];
  return {
    notes,
    ctx: {
      cwd,
      hasUI: true,
      ui: {
        notify: (msg: string, kind?: string) => {
          notes.push({ msg, kind });
        },
      },
    },
  };
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor: timed out");
}

/* ---------- harness ---------- */

let cwd: string;
let api: Api;
let started = false;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "gas-sync-"));
  mockState.agentDir = mkdtempSync(join(tmpdir(), "gas-agent-"));
  started = false;
});

afterEach(() => {
  if (started) {
    api.handlers.get("session_shutdown")?.forEach((h) => h(undefined, undefined));
  }
  rmSync(cwd, { recursive: true, force: true });
  rmSync(mockState.agentDir, { recursive: true, force: true });
});

function projectConfig(obj: object) {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "git-auto-sync.json"), JSON.stringify(obj));
}

function readProjectConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(cwd, ".pi", "git-auto-sync.json"), "utf-8"));
}

function boot(git: GitState) {
  api = makeApi(git);
  gitAutoSync(api as never);
  const { ctx } = sessionCtx(cwd);
  api.handlers.get("session_start")?.forEach((h) => h(undefined, ctx));
  started = true;
}

function runCmd(args: string) {
  const { ctx, notes } = cmdCtx(cwd);
  const cmd = api.commands.get("git-sync");
  return Promise.resolve(cmd?.handler(args, ctx)).then(() => notes);
}

/* ---------- tests ---------- */

describe("startup", () => {
  it("clean + up to date: no agent message, no merge", async () => {
    boot({ dirty: false, behind: 0 });
    await waitFor(() => api.calls.includes("rev-list --count HEAD..@{u}"));
    expect(api.messages).toHaveLength(0);
    expect(api.calls).not.toContain("merge --ff-only @{u} --no-edit");
  });

  it("behind + clean: fast-forward, push, headless-safe record", async () => {
    boot({ dirty: false, behind: 2 });
    await waitFor(() => api.calls.includes("push"));
    expect(api.calls).toContain("merge --ff-only @{u} --no-edit");
    const rec = api.messages.find((m) => m.includes("fast-forwarded"));
    expect(rec).toContain("behind origin by 2");
    expect(rec).toContain("informational");
  });

  it("behind + dirty: asks the agent", async () => {
    boot({ dirty: true, behind: 2 });
    await waitFor(() => api.messages.some((m) => m.includes("On startup, local is behind origin by")));
    const msg = api.messages.find((m) => m.includes("On startup"))!;
    expect(msg).toContain("2 commit(s)");
    expect(api.calls).not.toContain("merge --ff-only @{u} --no-edit");
  });

  it("startupSync=false skips the fetch entirely", async () => {
    projectConfig({ startupSync: false });
    boot({ dirty: false, behind: 2 });
    await new Promise((r) => setTimeout(r, 60));
    expect(api.calls).not.toContain("fetch origin");
    expect(api.messages).toHaveLength(0);
  });
});

describe("idle trigger", () => {
  it("triggers after the configured idle window", async () => {
    projectConfig({ pollMs: 20, idleMs: 80 });
    boot({ dirty: true, behind: 0 });
    await waitFor(() => api.messages.some((m) => m.includes("Please perform git sync")));
    const msg = api.messages.find((m) => m.includes("Please perform git sync"))!;
    expect(msg).toContain("dirty for 80 ms or more");
    expect(msg).toContain("2 file(s) changed");
  });

  it("does not trigger while clean", async () => {
    projectConfig({ pollMs: 20, idleMs: 40 });
    boot({ dirty: false, behind: 0 });
    await new Promise((r) => setTimeout(r, 150));
    expect(api.messages).toHaveLength(0);
  });
});

describe("enabled switch", () => {
  it("enabled=false: no startup sync, no polling", async () => {
    projectConfig({ enabled: false, pollMs: 20, idleMs: 40 });
    boot({ dirty: true, behind: 2 });
    await new Promise((r) => setTimeout(r, 150));
    expect(api.calls).not.toContain("fetch origin");
    expect(api.messages).toHaveLength(0);
  });

  it("off persists and stops; on re-enables and triggers", async () => {
    projectConfig({ pollMs: 20, idleMs: 60 });
    boot({ dirty: true, behind: 0 });
    await new Promise((r) => setTimeout(r, 30));

    await runCmd("off");
    expect(readProjectConfig().enabled).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(api.messages).toHaveLength(0); // halted, nothing triggered

    await runCmd("on");
    expect(readProjectConfig().enabled).toBe(true);
    await waitFor(() => api.messages.some((m) => m.includes("Please perform git sync")));
  });

  it("force sync works even when disabled", async () => {
    projectConfig({ enabled: false });
    boot({ dirty: true, behind: 0 });
    await runCmd("");
    expect(api.messages.some((m) => m.includes("Please perform git sync"))).toBe(true);
  });
});

describe("commands", () => {
  it("set idle persists a human duration", async () => {
    projectConfig({ pollMs: 20 });
    boot({ dirty: false, behind: 0 });
    const notes = await runCmd("set idle 5m");
    expect(readProjectConfig().idleMs).toBe(300_000);
    expect(notes.find((n) => n.msg.includes("idle = 5 min"))?.msg).toContain("(saved)");
  });

  it("set idle rejects values below the minimum", async () => {
    projectConfig({ pollMs: 20 });
    boot({ dirty: false, behind: 0 });
    const notes = await runCmd("set idle 30s");
    expect(notes.find((n) => n.kind === "error")?.msg).toContain("at least 1 min");
    expect(readProjectConfig().idleMs).toBeUndefined();
  });

  it("set poll rejects sub-second values", async () => {
    projectConfig({ pollMs: 20 });
    boot({ dirty: false, behind: 0 });
    const notes = await runCmd("set poll 100ms");
    expect(notes.find((n) => n.kind === "error")?.msg).toContain("at least 1 s");
  });

  it("set startup persists without touching the timer", async () => {
    projectConfig({ pollMs: 20 });
    boot({ dirty: false, behind: 0 });
    const notes = await runCmd("set startup false");
    expect(readProjectConfig().startupSync).toBe(false);
    expect(notes.find((n) => n.msg.includes("startup = false"))?.msg).toContain("(saved)");
  });

  it("set with unknown key or bad value errors", async () => {
    projectConfig({ pollMs: 20 });
    boot({ dirty: false, behind: 0 });
    const bad1 = await runCmd("set bogus 1");
    expect(bad1.find((n) => n.kind === "error")?.msg).toContain("Unknown key");
    const bad2 = await runCmd("set enabled maybe");
    expect(bad2.find((n) => n.kind === "error")?.msg).toContain("Invalid value");
  });

  it("status reports the effective config", async () => {
    projectConfig({ pollMs: 15_000, idleMs: 120_000 });
    boot({ dirty: false, behind: 0 });
    const notes = await runCmd("status");
    const line = notes.find((n) => n.msg.includes("git-auto-sync:"))?.msg;
    expect(line).toContain("on · startup: on · idle: 2 min · poll: 15 s");
    expect(line).toContain(join(cwd, ".pi", "git-auto-sync.json"));
  });

  it("pause stops triggers; resume restarts them", async () => {
    projectConfig({ pollMs: 20, idleMs: 60 });
    boot({ dirty: true, behind: 0 });
    await new Promise((r) => setTimeout(r, 30));
    await runCmd("pause");
    await new Promise((r) => setTimeout(r, 150));
    expect(api.messages).toHaveLength(0);
    await runCmd("resume");
    await waitFor(() => api.messages.some((m) => m.includes("Please perform git sync")));
  });
});
