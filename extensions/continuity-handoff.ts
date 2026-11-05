import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { uuidv7, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_DIR = "agent-handoffs";
const HOME_STATE_DIR = join(homedir(), ".pi", STATE_DIR);
const MAX_HANDOFF_CHARS = 8_000;
const MAX_CONVERSATION_CHARS = 10_000;
const MAX_ENTRIES = 40;

type Snapshot = {
  kind: "git" | "directory";
  branch: string;
  root: string;
  handoffPath: string;
  status: string;
  log: string;
  diff: string;
  diffExcerpt: string;
  entries: string;
  handoff: string;
};

function clip(value: string, limit: number): string {
  const text = value.trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`;
}

function display(value: string): string {
  return value.trim() || "(none)";
}

async function git(pi: ExtensionAPI, args: string[]): Promise<string | undefined> {
  const result = await pi.exec("git", args, { timeout: 5_000 });
  return result.code === 0 ? result.stdout.trim() : undefined;
}

function stateKey(root: string): string {
  return createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
}

function handoffPathForGit(commonDir: string, root: string): string {
  return resolve(commonDir, STATE_DIR, `${stateKey(root)}.md`);
}

/** Handoffs outside a Git repository live in a stable per-directory state dir. */
function handoffPathForDirectory(root: string): string {
  return resolve(HOME_STATE_DIR, `${stateKey(root)}.md`);
}

async function readHandoff(path: string): Promise<string> {
  try {
    return clip(await readFile(path, "utf8"), MAX_HANDOFF_CHARS);
  } catch {
    return "";
  }
}

async function projectEntries(root: string): Promise<string> {
  try {
    const dirents = await readdir(root, { withFileTypes: true });
    const names = dirents
      .filter((dirent) => !dirent.name.startsWith("."))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, MAX_ENTRIES)
      .map((dirent) => (dirent.isDirectory() ? `${dirent.name}/` : dirent.name));
    return clip(display(names.join("\n")), 2_000);
  } catch {
    return "(not readable)";
  }
}

async function inspect(pi: ExtensionAPI, cwd: string): Promise<Snapshot> {
  const root = await git(pi, ["rev-parse", "--show-toplevel"]);
  const commonRaw = await git(pi, ["rev-parse", "--git-common-dir"]);

  if (!root || !commonRaw) {
    const projectRoot = resolve(cwd);
    const path = handoffPathForDirectory(projectRoot);
    return {
      kind: "directory",
      branch: "(no Git repository)",
      root: projectRoot,
      handoffPath: path,
      status: "(no Git repository)",
      log: "(no Git repository)",
      diff: "(no Git repository)",
      diffExcerpt: "(no Git repository)",
      entries: await projectEntries(projectRoot),
      handoff: await readHandoff(path),
    };
  }

  const commonDir = isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw);
  const path = handoffPathForGit(commonDir, root);
  const [branch, status, log, unstaged, staged, unstagedNames, stagedNames, unstagedPatch, stagedPatch, entries, handoff] = await Promise.all([
    git(pi, ["branch", "--show-current"]),
    git(pi, ["status", "--short"]),
    git(pi, ["log", "--oneline", "-8"]),
    git(pi, ["diff", "--stat"]),
    git(pi, ["diff", "--cached", "--stat"]),
    git(pi, ["diff", "--name-status"]),
    git(pi, ["diff", "--cached", "--name-status"]),
    git(pi, ["diff", "--no-ext-diff", "--unified=0"]),
    git(pi, ["diff", "--cached", "--no-ext-diff", "--unified=0"]),
    projectEntries(root),
    readHandoff(path),
  ]);

  return {
    kind: "git",
    branch: branch || "(detached HEAD)",
    root,
    handoffPath: path,
    status: clip(display(status || ""), 2_000),
    log: clip(display(log || ""), 2_000),
    diff: clip(display([unstaged, staged, unstagedNames, stagedNames].filter(Boolean).join("\n")), 4_000),
    diffExcerpt: clip(display([unstagedPatch, stagedPatch].filter(Boolean).join("\n")), 4_000),
    entries,
    handoff,
  };
}

function snapshotText(snapshot: Snapshot): string {
  if (snapshot.kind === "git") {
    return [
      `Worktree: ${snapshot.root}`,
      `Branch: ${snapshot.branch}`,
      `Status:\n${snapshot.status}`,
      `Recent commits:\n${snapshot.log}`,
      `Diff summary:\n${snapshot.diff}`,
    ].join("\n");
  }
  return [
    `Project directory: ${snapshot.root}`,
    "Version control: not a Git repository (no branch, status, commits or diff available)",
    `Top-level entries:\n${snapshot.entries}`,
    `Handoff state: ${snapshot.handoffPath}`,
  ].join("\n");
}

function startupText(snapshot: Snapshot, contextFiles: string[]): string {
  const handoff = snapshot.handoff ? `Saved handoff:\n${snapshot.handoff}` : "Saved handoff: (none)";
  const instructions = contextFiles.length > 0 ? contextFiles.join(", ") : "(Pi loaded none)";
  return [
    "## Continuity snapshot",
    snapshotText(snapshot),
    handoff,
    `Loaded project instructions: ${instructions}`,
    "Before editing, internally confirm this snapshot was inspected. Treat the filesystem as truth, and Git state when a repository exists; do not assume parallel worktrees are merged. Do not commit, push, merge, stash, or touch unrelated changes unless the user explicitly asks.",
  ].join("\n\n");
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text?: string } => Boolean(part) && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
}

function recentConversation(ctx: ExtensionCommandContext): string {
  const messages = ctx.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => ({
      role: entry.message.role,
      text: messageText("content" in entry.message ? entry.message.content : undefined),
    }))
    .filter((entry) => (entry.role === "user" || entry.role === "assistant") && entry.text.trim())
    .slice(-12)
    .map((entry) => `[${entry.role}] ${clip(entry.text, 1_200)}`)
    .join("\n\n");
  return clip(messages, MAX_CONVERSATION_CHARS);
}

function changesText(snapshot: Snapshot): string {
  return snapshot.kind === "git"
    ? `${snapshot.status}\n\nDiff summary:\n${snapshot.diff}`
    : `No Git repository. Top-level entries:\n${snapshot.entries}`;
}

function fallbackHandoff(snapshot: Snapshot, objective: string): string {
  return [
    "# Agent handoff",
    `## Objective\n${objective || (snapshot.kind === "git" ? "Continue the current branch from Git state." : "Continue work in this project directory.")}`,
    `## Completed\n${snapshot.kind === "git" ? `Recent commits:\n${snapshot.log}` : `Project: ${snapshot.root}`}`,
    `## Uncommitted changes\n${changesText(snapshot)}`,
    "## Tests\nNot recorded automatically.",
    `## Technical decision\n${snapshot.kind === "git" ? "Git and this local handoff are" : "This local handoff and the working tree are"} the continuity record; no commit was created.`,
    "## Next step\nInspect the project state above and continue the next concrete task.",
    "## Blockers or questions\nNone recorded.",
  ].join("\n\n");
}

function section(markdown: string, heading: string): string {
  const match = markdown.match(new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`));
  return match?.[1].trim() || "Not recorded.";
}

function renderHandoff(snapshot: Snapshot, objective: string, generated: string): string {
  return [
    "# Agent handoff",
    `## Objective\n${objective || section(generated, "Objective")}`,
    `## Completed\n${section(generated, "Completed")}`,
    `## Uncommitted changes\n${changesText(snapshot)}`,
    `## Tests\n${section(generated, "Tests")}`,
    `## Technical decision\n${section(generated, "Technical decision")}`,
    `## Next step\n${section(generated, "Next step")}`,
    `## Blockers or questions\n${section(generated, "Blockers or questions")}`,
  ].join("\n\n");
}

async function generateHandoff(ctx: ExtensionCommandContext, snapshot: Snapshot, objective: string): Promise<string> {
  if (!ctx.model) return fallbackHandoff(snapshot, objective);

  const prompt = [
    "Write only a concise Markdown handoff using exactly these headings:",
    "# Agent handoff",
    "## Objective",
    "## Completed",
    "## Uncommitted changes",
    "## Tests",
    "## Technical decision",
    "## Next step",
    "## Blockers or questions",
    "Use only supplied facts. If a fact is unknown, say 'Not recorded.' Do not claim commits, pushes, merges, or tests that did not occur. The next step must be one sentence.",
    `Optional objective from /handoff: ${objective || "(none)"}`,
    `Project snapshot:\n${snapshotText(snapshot)}`,
    `Diff or project context excerpt (bounded):\n${snapshot.diffExcerpt}`,
    `Recent conversation:\n${recentConversation(ctx) || "(none)"}`,
  ].join("\n\n");
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }];

  try {
    const response = await ctx.modelRegistry.complete(
      ctx.model,
      { messages },
      { maxTokens: 1_200, cacheRetention: "none", sessionId: uuidv7() },
    );
    const summary = response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    return summary.includes("## Objective")
      ? clip(renderHandoff(snapshot, objective, summary), MAX_HANDOFF_CHARS)
      : fallbackHandoff(snapshot, objective);
  } catch {
    return fallbackHandoff(snapshot, objective);
  }
}

async function save(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${content.trim()}\n`, "utf8");
  await rename(temporary, path);
}

export default function continuityHandoff(pi: ExtensionAPI) {
  let snapshot: Snapshot | undefined;
  let wasInjected = false;

  pi.on("session_start", async (_event, ctx) => {
    snapshot = await inspect(pi, ctx.cwd);
    wasInjected = false;
    const scope = snapshot.kind === "git" ? `branch ${snapshot.branch}` : `project ${basename(snapshot.root)}`;
    ctx.ui.setWidget("continuity-handoff", [
      `continuity: ${scope}`,
      snapshot.handoff ? "handoff: recovered" : "handoff: none",
      "Use /handoff before changing agents.",
    ]);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (wasInjected) return;
    wasInjected = true;
    const contextFiles = event.systemPromptOptions.contextFiles?.map((file) => file.path) ?? [];
    return {
      message: {
        customType: "continuity-handoff",
        content: startupText(snapshot ?? emptySnapshot(ctx.cwd), contextFiles),
        display: true,
      },
    };
  });

  pi.registerCommand("handoff", {
    description: "Save a concise handoff for this worktree or project directory",
    handler: async (args, ctx) => {
      const current = await inspect(pi, ctx.cwd);
      const content = await generateHandoff(ctx, current, args.trim());
      await save(current.handoffPath, content);
      snapshot = { ...current, handoff: content };
      ctx.ui.notify(
        `Handoff saved (${current.kind === "git" ? "Git worktree" : "project directory"}). New agent: inspect ${current.handoffPath} and continue the recorded next step.`,
        "info",
      );
    },
  });
}

function emptySnapshot(cwd: string): Snapshot {
  const root = resolve(cwd);
  return {
    kind: "directory",
    branch: "(no Git repository)",
    root,
    handoffPath: handoffPathForDirectory(root),
    status: "(no Git repository)",
    log: "(no Git repository)",
    diff: "(no Git repository)",
    diffExcerpt: "(no Git repository)",
    entries: "(not inspected yet)",
    handoff: "",
  };
}
