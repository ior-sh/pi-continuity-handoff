# pi-continuity-handoff

Durable, project-aware handoffs for the [Pi](https://github.com/earendil-works/pi) coding agent.

At session start, Pi receives a short snapshot of the real state of the project: branch, status, recent commits and diff when a Git repository exists, or the directory and its top-level entries when it does not. `/handoff` writes one Markdown handoff next to that state, and the next session reads it automatically.

No session switching, no compaction hook, no background process. The handoff is a file on disk that survives restarts, crashes and profile changes.

## Install

```bash
pi install git:github.com/ior-sh/pi-continuity-handoff
```

Try it without installing:

```bash
pi -e git:github.com/ior-sh/pi-continuity-handoff
```

Restart Pi after installing, or run `/reload` in a live session.

## Usage

```bash
/handoff                      # write a handoff for this worktree or project directory
/handoff continue the auth refactor   # record an explicit objective
```

The command asks the active model for a concise handoff in a fixed shape and falls back to a deterministic summary when no model is available. The file is written atomically (temporary file plus rename).

At the start of every session the agent receives the snapshot and, if one exists, the saved handoff. Nothing else is required: the next agent starts from the file, not from the transcript.

### Injected block

```
## Continuity snapshot

Worktree: /home/user/src/app
Branch: main
Status:
M src/auth.ts
Recent commits:
41c9f2b extract token validation
Diff summary:
 src/auth.ts | 12 ++++++------

Saved handoff:
# Agent handoff
## Objective
Continue the auth refactor.

## Uncommitted changes
...

Loaded project instructions: /home/user/src/app/AGENTS.md

Before editing, internally confirm this snapshot was inspected. Treat the filesystem as truth, and Git state when a repository exists; do not assume parallel worktrees are merged. Do not commit, push, merge, stash, or touch unrelated changes unless the user explicitly asks.
```

Outside a Git repository the snapshot shows the project directory, a note that no repository exists, the top-level entries and the handoff path.

## Handoff shape

Every handoff uses the same headings, so the next session reads the same structure every time:

- Objective
- Completed
- Uncommitted changes
- Tests
- Technical decision
- Next step
- Blockers or questions

## State locations

| Context | Path | Scope |
| --- | --- | --- |
| Git repository | `<git-common-dir>/agent-handoffs/<hash>.md` | one file per worktree, shared by all worktrees of the repository, never committed |
| Any other directory | `~/.pi/agent-handoffs/<hash>.md` | one file per project directory, shared across Pi profiles |

`<hash>` is the first 16 hex characters of SHA-256 over the resolved root path.

Keeping the state inside the Git directory means a handoff travels with the repository when it is cloned or moved, stays out of `git status`, and does not disappear when a worktree is removed. Directories without Git get a stable per-path file under the home directory instead, so a handoff still works for notes, scratch projects and single-file work.

## Limits

| Bound | Value |
| --- | --- |
| Saved handoff read into context | 8,000 characters |
| Conversation excerpt given to the model | 10,000 characters |
| Recent messages considered | 12 |
| Directory entries listed | 40 |
| Status, commits, diff summary | 2,000 / 2,000 / 4,000 characters |
| Model output for one handoff | 1,200 tokens |

## Privacy

Handoffs are plain-text local files. They may contain file paths, branch names, diff summaries, project directory listings and excerpts of the conversation. Nothing is uploaded: the extension only runs `git` locally, reads and writes files, and makes one model call through the model already selected in Pi.

Nothing is written until `/handoff` runs, apart from reading an existing handoff at session start.

## Behaviour details

- The snapshot is injected once per session, before the first agent turn.
- The widget shows the current scope (`branch main` or `project my-notes`) and whether a handoff was recovered.
- The model call is optional: without a selected model, or if the call fails, the handoff is still saved using the deterministic summary.
- Git is never mutated: the extension only reads `rev-parse`, `branch`, `status`, `log` and `diff`.

## Compatibility

- Requires a Pi version that exposes `session_start`, `before_agent_start` with `systemPromptOptions.contextFiles`, `ctx.cwd`, `registerCommand` and `ui.setWidget`.
- Requires Node.js 22.19.0 or later, matching Pi itself.
- Linux, macOS and Windows; the only external process used is `git`, and its absence is handled.

## License

MIT. See [LICENSE](LICENSE).
