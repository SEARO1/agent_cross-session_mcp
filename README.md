# agent-cross-session-mcp

**TL;DR** — 一個 MCP server，令 DSH 唔同 session 嘅 agent 知道彼此做緊咩：邊個 session 喺邊個 workspace、跑緊乜 tool、最後一句 human 問咩、最後答咗啲乜，仲可以互相留低 note。

It reads DSH's own session logs (`~/.dsh/sessions/**/session.v2.jsonl.zstd`) and never writes to another
session. A small append-only board carries voluntary announcements.

## Why this exists

DSH sessions are isolated: a session sees its own conversation and nothing about what the
other windows on the same machine are doing. Two agents can end up editing the same repo,
re-doing the same research, or contradicting a decision the other one just made.

This server closes that gap with two read paths and one write path:

| Path | Source | Freshness |
|---|---|---|
| Live activity | the caller's and peers' session logs, which DSH appends per batch of events | seconds |
| Announcements | `<DSH_HOME>/cross-session/board.jsonl`, written by `announce` | immediate |

## Tools

| Tool | Answers |
|---|---|
| `peers` | Who else is running, in which workspace, doing what — tool in flight, last human request, last reply. |
| `session_detail` | The recent timeline of one session: human messages, agent replies, tool calls in order. |
| `overlaps` | Which files two sessions both touched, which share a workspace, and which ran git in the same repo. |
| `announce` | Post a note for the other sessions (what you own, what you decided). |
| `board` | Read the notes other sessions posted, newest first. |
| `whoami` | Which session am I, which workspace, what am I doing. |

Example `peers` output:

```
DSH sessions — 2 shown of 12 on disk · 1 running a tool · active within 30m · now 09-12 01:56

1) 74f51504
   workspace : C:\Users\cheun\OneDrive\Desktop\agent_cross-session_mcp
   status    : busy — running run_code (last event 1s ago)
   said      : (turn in progress)

2) fa12628a
   workspace : C:\Users\cheun\.dsh
   status    : idle (last event 13m ago)
   said      : 搞好晒，寫入咗 my_agent_setting repo（3 個檔改動，未 commit）…
```

## How it works

**Session logs are a concatenated Zstandard container.** Node's `zstdDecompressSync` decodes only the
first frame, so `lib/session-logs.mjs` locates frames structurally first (frame header, then block
headers — a compressed block stores its own compressed length, so no decompression is needed
to find the next frame), then decodes one frame at a time. A write in progress shows up as a
torn final frame and is skipped until the next poll.

**Reads are windowed.** Only the head frame (session header, title) and the newest frames
(current turn) are decoded, so polling every session stays cheap.

**The calling session is recovered, not assumed.** DSH does not forward a session identity to
MCP servers — a `tools/call` request carries only the tool name and arguments. But DSH appends the
caller's own record to its log *before* the call is served: `tool/call` for a tool the model calls
directly, `tool/code-dispatch-start` for the same tool called from inside `run_code`. So
`identifyCaller()` reads the logs written in the last two minutes, matches either record, and
reports that session as `← this session`. When identification fails, `announce` still stores the
note and says it was anonymous.

**Nothing here needs DSH to change.** The server is a plain stdio MCP process; DSH mounts it
through `dsh-mcp-client` like any other MCP server.

## Collision prevention

Two sessions in one repo is the case this server exists for, so the peer view carries the
evidence a collision would leave:

- @@BT@@peers@@BT@@ adds a @@BT@@touched@@BT@@ line per session: the newest files that session read or wrote
  (@@BT@@(w)@@BT@@ marks a write) plus the git subcommands it ran.
- @@BT@@overlaps@@BT@@ compares every recently active session and reports, in one report: sessions sharing
  a workspace, how many files each wrote, git races (@@BT@@add -A@@BT@@, @@BT@@commit@@BT@@, @@BT@@checkout@@BT@@ in the same repo), and
  each file more than one session touched — @@BT@@⚠ CONFLICT@@BT@@ when both wrote it.
- Status lines separate real work from log writes: a session that was only seeded or resumed
  reads @@BT@@idle (last work 1d2h ago · log written 27m ago (seed/resume))@@BT@@ instead of looking active.

This is **advisory**: nothing here blocks a write, and nothing appears unless an agent asks.
For hard isolation give each session its own @@BT@@git worktree@@BT@@ (see the @@BT@@using-git-worktrees@@BT@@ skill) —
the radar then covers what worktrees cannot: the same working tree reopened twice, files
outside any repo, and the git commands themselves.

## Install

```powershell
npm install --cache .\.npm-cache           # sandboxed npm needs its cache inside the project
pwsh -File scripts/install-to-dsh.ps1 -Commit
```

The script copies `skills/cross-session` into `<DSH_HOME>/skills`, inserts the
`install/cordis-block.yml` row into `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` once
(leaving a `.bak` beside it), and refreshes the `my_agent_setting` mirror. It derives every
path from the repository location, so a fresh clone on another machine works unchanged; override the
targets with `DSH_HOME` / `CROSS_SESSION_MIRROR` and the profile with `-Profile`.

## Register it in DSH

Add one row to `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: mcp-cross-session
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: crosssession
        transport: stdio
        command: node
        args: ['C:\Users\cheun\OneDrive\Desktop\agent_cross-session_mcp\server.mjs']
        cwd: 'C:\Users\cheun\OneDrive\Desktop\agent_cross-session_mcp'
```

Notes:

- `serverName` must match `CROSS_SESSION_SERVER_NAME` (default `crosssession`), because the
  tools appear to the model as `mcp__crosssession__peers` and caller identification matches those
  exact names.
- New rows must be added with the `insert:` form; an `- id:` override for a row that does not
  exist yet is silently dropped.
- The harness picks the row up on reload; a gateway restart is the reliable way.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | Home whose `sessions/` directory is read. |
| `DSH_SESSIONS_DIR` | `<DSH_HOME>/sessions` | Session store root, when it is not under the home. |
| `CROSS_SESSION_BOARD` | `<DSH_HOME>/cross-session/board.jsonl` | Announcement log. |
| `CROSS_SESSION_SERVER_NAME` | `crosssession` | MCP server name used for caller identification. |

## Layout

```
server.mjs                    stdio transport only (MCP SDK wiring)
lib/tools.mjs                 tool definitions, handlers, rendering
lib/session-logs.mjs          zstd frame scanner, windowed reader, summarizer, activity, caller lookup
lib/board.mjs                 append-only announcement log with size-capped compaction
skills/cross-session/SKILL.md the DSH skill that tells an agent when to reach for these tools
install/cordis-block.yml      the MCP row, with __ROOT__/__SERVER__ placeholders
scripts/install-to-dsh.ps1    installs the skill + row into the live DSH home and mirrors my_agent_setting
test.mjs                      tests: frame scanner, summarizer, activity, caller lookup, every tool, stdio
spike/                        throwaway probes used to reverse-engineer the session-log format
```

## Test

```powershell
npm install --cache .\.npm-cache   # sandboxed npm needs its cache inside the project
npm test
```

The stdio round trip is skipped when the sandbox forbids spawning a child with pipes
(`spawn EPERM`); everything else runs without a transport.

## Limitations

- **Live sessions only show what is already on disk.** Activity is derived from log mtimes and
  records, so a session that just started may show one poll late.
- **Session format v2 only** (`session.v2.jsonl.zstd`). An older or future format is not parsed.
- **Subagent work is not a separate session** — it appears inside its parent's log.
- **Titles come from the log**, so an untitled session shows no title until DSH writes one.
- **The board is machine-local and unauthenticated**: any session on this machine can post.
