/**
 * The cross-session tool surface: what each tool answers and how it is rendered.
 *
 * The server never touches another session: it only reads DSH's own session
 * logs (`~/.dsh/sessions/**`, appended live while a session runs) plus a small
 * announcement board that sessions post to voluntarily.
 *
 * DSH does not forward a session identity to MCP servers, so the calling
 * session is recovered from the caller's own `tool/call` record, which DSH
 * appends before the call is served.
 *
 * Environment:
 * - `DSH_HOME` / `DSH_SESSIONS_DIR` — where session logs live.
 * - `CROSS_SESSION_BOARD` — board file path.
 * - `CROSS_SESSION_SERVER_NAME` — MCP server name (default `crosssession`),
 *   which must match the `serverName` in the DSH MCP registration.
 *
 * @module cross-session/tools
 */
import {
  buildTimeline,
  collectActivity,
  formatAge,
  identifyCaller,
  listSessionLogs,
  oneLine,
  peekSession,
  readSessionRecords,
  sessionsRoot,
  summarizeSession,
  truncate,
} from './session-logs.mjs';
import { appendAnnouncement, boardFile, readAnnouncements } from './board.mjs';

/** MCP server name; must match `serverName` in the DSH registration. */
const SERVER_NAME = process.env.CROSS_SESSION_SERVER_NAME ?? 'crosssession';
/** Reported server version. */
const SERVER_VERSION = '0.1.0';
/** Window sizes for cheap reads: one head frame carries the session header. */
const HEAD_FRAMES = 1;
/** Tail frames decoded for a peers summary — roughly the last few turns. */
const SUMMARY_TAIL_FRAMES = 30;


/** Tool definitions published to the model. */
const TOOLS = [
  {
    name: 'peers',
    description:
      'See what the other DSH agent sessions on this machine are doing right now: their workspace, title, whether a tool is still running, the last thing the human asked them, and the last thing they answered. Use it before touching files or repos another session might be editing, when the user mentions another window or session, or to check whether a task is already being handled elsewhere.',
    inputSchema: {
      type: 'object',
      properties: {
        active_within_minutes: {
          type: 'number',
          description: 'Only show sessions with activity in the last N minutes (default 30).',
        },
        limit: { type: 'number', description: 'Maximum sessions to show (default 8).' },
        include_dormant: {
          type: 'boolean',
          description: 'Include sessions with no recent activity (default false).',
        },
        workspace: {
          type: 'string',
          description: 'Only show sessions whose workspace path contains this text.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'session_detail',
    description:
      'Read the recent activity timeline of one DSH session in order: human messages, agent replies, and tool calls. Use it after `peers` when another session\'s work matters to yours — to see exactly what it changed, decided, or is still running.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Full session id or an unambiguous prefix, as shown by `peers`.',
        },
        limit: { type: 'number', description: 'Maximum timeline entries, newest kept (default 30).' },
        frames: {
          type: 'number',
          description: 'How many log frames of history to decode; higher is deeper (default 24).',
        },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'overlaps',
    description:
      'Report collision risk between DSH sessions: files touched by more than one session, sessions sharing one workspace, and git commands run in the same repo. Use it before editing a repo another session is working in, or when the user asks whether two sessions will clash.',
    inputSchema: {
      type: 'object',
      properties: {
        active_within_minutes: { type: 'number', description: 'How far back to look for activity (default 240).' },
        limit: { type: 'number', description: 'Maximum sessions to consider (default 12).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'announce',
    description:
      'Post a short note for the other DSH sessions: what you are working on, which files or repo you are touching, or a decision they need to see. Other sessions read it with `board`. Call it when you start something long, take ownership of files another session might edit, or finish a task.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'One or two sentences, in the language of the conversation.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'board',
    description: 'Read the notes other DSH sessions posted with `announce`, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum notes to return (default 20).' },
        since_minutes: { type: 'number', description: 'Only notes younger than N minutes.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'whoami',
    description:
      'Identify which DSH session you are running in: session id, workspace, title, and whether a tool is currently running. Useful when you need to tell a human or another session where a note came from.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/** Fully qualified names DSH will use when calling this server's tools. */
const PUBLIC_NAMES = TOOLS.map((tool) => `mcp__${SERVER_NAME}__${tool.name}`);

/**
 * List active sessions and what each one is doing.
 * @param args - tool arguments.
 * @returns rendered peer report.
 */
async function handlePeers(args) {
  const activeWithinMinutes = numberArg(args.active_within_minutes, 30);
  const limit = Math.max(1, Math.round(numberArg(args.limit, 8)));
  const includeDormant = args.include_dormant === true;
  const workspace = typeof args.workspace === 'string' ? args.workspace.trim().toLowerCase() : '';

  const logs = listSessionLogs();
  if (logs.length === 0) return `No DSH session logs found under ${sessionsRoot()}.`;
  const cutoff = Date.now() - activeWithinMinutes * 60_000;
  let selected = logs.filter((log) => includeDormant || log.mtimeMs >= cutoff);
  if (workspace) selected = selected.filter((log) => log.file.toLowerCase().includes(workspace));
  const caller = await identifyCaller(PUBLIC_NAMES, { attempts: 3, delayMs: 150 });
  const rows = selected.slice(0, limit).map((log) => {
    const peeked = peekSession(log, { headFrames: HEAD_FRAMES, tailFrames: SUMMARY_TAIL_FRAMES });
    return {
      summary: peeked.summary,
      activity: collectActivity(peeked.records, { cwd: peeked.summary.cwd, sinceMs: cutoff }),
    };
  });
  if (rows.length === 0) {
    return `No DSH session has been active in the last ${activeWithinMinutes} minutes (${logs.length} on disk). Pass include_dormant to list them anyway.`;
  }
  return renderPeers(rows, { total: logs.length, activeWithinMinutes, caller });
}

/**
 * Show one session's recent activity timeline.
 * @param args - tool arguments.
 * @returns rendered timeline.
 */
async function handleSessionDetail(args) {
  const wanted = String(args.session_id ?? '').trim();
  if (!wanted) throw new Error('session_id is required — call peers to list session ids');
  const log = resolveSession(wanted);
  const frames = Math.max(2, Math.round(numberArg(args.frames, 24)));
  const limit = Math.max(1, Math.round(numberArg(args.limit, 30)));
  const read = readSessionRecords(log.file, { headFrames: HEAD_FRAMES, tailFrames: frames });
  const summary = summarizeSession(read.records, { ...read, sessionId: log.sessionId });
  const timeline = buildTimeline(read.records, limit);
  const lines = [renderSessionHead(summary)];
  if (timeline.length === 0) lines.push('', '(no recent messages or tool calls in the decoded window)');
  for (const entry of timeline) {
    const mark = entry.pending ? ' (still running)' : '';
    lines.push(`${formatStamp(entry.at)}  ${entry.kind.padEnd(9)} ${truncate(oneLine(entry.text), 320)}${mark}`);
  }
  if (read.windowed) {
    lines.push('', `(decoded the newest ${read.decodedFrameCount} of ${read.frameCount} frames — raise frames for more history)`);
  }
  return lines.join('\n');
}

/**
 * Post an announcement for the other sessions.
 * @param args - tool arguments.
 * @returns confirmation plus the newest board entries.
 */
async function handleAnnounce(args) {
  const text = String(args.text ?? '').trim();
  if (!text) throw new Error('text is required');
  const caller = await identifyCaller(PUBLIC_NAMES, { attempts: 4, delayMs: 250 });
  appendAnnouncement({ sessionId: caller?.sessionId ?? null, cwd: caller?.cwd ?? null, text });
  const head =
    caller === null
      ? 'Posted, but the calling session could not be identified (stored anonymously).'
      : `Posted as ${shortId(caller.sessionId)} (${caller.cwd ?? 'unknown workspace'}).`;
  return [head, '', renderBoard(readAnnouncements({ limit: 5 }))].join('\n');
}

/**
 * Read the announcement board.
 * @param args - tool arguments.
 * @returns rendered board.
 */
function handleBoard(args) {
  const limit = Math.max(1, Math.round(numberArg(args.limit, 20)));
  const sinceMinutes = numberArg(args.since_minutes, Number.NaN);
  const sinceMs = Number.isFinite(sinceMinutes) ? Date.now() - sinceMinutes * 60_000 : null;
  return renderBoard(readAnnouncements({ limit, sinceMs }));
}

/**
 * Identify the session serving this call.
 * @returns rendered identity, or an explanation when it could not be resolved.
 */
async function handleWhoami() {
  const caller = await identifyCaller(PUBLIC_NAMES, { attempts: 4, delayMs: 250 });
  if (caller === null) {
    return 'Could not identify the calling session: no matching tool/call record was found in any session log written in the last two minutes.';
  }
  const log = listSessionLogs().find((candidate) => candidate.sessionId === caller.sessionId);
  const summary = log === undefined ? null : peekSession(log, { headFrames: HEAD_FRAMES, tailFrames: SUMMARY_TAIL_FRAMES }).summary;
  return summary === null ? `You are ${caller.sessionId} (${caller.cwd ?? 'unknown workspace'}).` : renderSessionHead(summary, 'You are running in:');
}

/**
 * Resolve a session id or unambiguous prefix to its log descriptor.
 * @param wanted - full id or prefix from the model.
 * @returns the matching log descriptor.
 */
function resolveSession(wanted) {
  const logs = listSessionLogs();
  const needle = wanted.toLowerCase();
  const exact = logs.find((log) => log.sessionId.toLowerCase() === needle);
  if (exact !== undefined) return exact;
  const matches = logs.filter((log) => log.sessionId.toLowerCase().startsWith(needle) || shortId(log.sessionId) === needle);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`no session matches "${wanted}" — call peers to list ids`);
  throw new Error(`"${wanted}" matches ${matches.length} sessions — use a longer prefix`);
}

/**
 * Render the one-line-per-fact header of a session.
 * @param summary - session summary.
 * @param heading - optional heading line.
 * @returns rendered block.
 */
function renderSessionHead(summary, heading = null) {
  const lines = [];
  if (heading !== null) lines.push(heading);
  lines.push(`${shortId(summary.sessionId)} (${summary.sessionId})`);
  lines.push(`  workspace : ${summary.cwd ?? '(unknown)'}`);
  if (summary.title) lines.push(`  title     : ${truncate(oneLine(summary.title), 100)}`);
  lines.push(`  status    : ${describeStatus(summary)}`);
  if (summary.lastUserText) lines.push(`  asked     : ${truncate(oneLine(summary.lastUserText), 200)}`);
  if (summary.lastAssistantText) lines.push(`  said      : ${truncate(oneLine(summary.lastAssistantText), 200)}`);
  return lines.join('\n');
}

/**
 * Render the peer list.
 * @param rows - session summaries, newest activity first.
 * @param meta - totals and the resolved caller.
 * @returns rendered report.
 */
function renderPeers(rows, { total, activeWithinMinutes, caller }) {
  const busy = rows.filter((row) => row.summary.pendingTool !== null).length;
  const lines = [
    `DSH sessions — ${rows.length} shown of ${total} on disk · ${busy} running a tool · active within ${activeWithinMinutes}m · now ${formatStamp(Date.now())}`,
  ];
  rows.forEach(({ summary, activity }, index) => {
    const mine = caller !== null && caller.sessionId === summary.sessionId ? '   ← this session' : '';
    lines.push('');
    lines.push(`${index + 1}) ${shortId(summary.sessionId)}${mine}`);
    lines.push(`   workspace : ${summary.cwd ?? '(unknown)'}`);
    if (summary.title) lines.push(`   title     : ${truncate(oneLine(summary.title), 90)}`);
    lines.push(`   status    : ${describeStatus(summary)}`);
    if (summary.lastUserText) lines.push(`   asked     : ${truncate(oneLine(summary.lastUserText), 160)}`);
    if (summary.lastAssistantText) lines.push(`   said      : ${truncate(oneLine(summary.lastAssistantText), 160)}`);
    else if (summary.pendingTool !== null) lines.push('   said      : (turn in progress)');
    const touched = renderActivityLine(activity);
    if (touched !== '') lines.push(`   touched   : ${touched}`);
  });
  return lines.join('\n');
}

/**
 * Describe whether a session is running a tool or waiting.
 * @param summary - session summary.
 * @returns one status phrase.
 */
function describeStatus(summary) {
  const workAt = summary.lastWorkAt ?? summary.lastEventAt ?? summary.mtimeMs;
  const age = formatAge(workAt);
  if (summary.pendingTool !== null) {
    const nested = summary.pendingNestedTool === null || summary.pendingNestedTool === undefined ? '' : ` → ${summary.pendingNestedTool}`;
    return `busy — running ${summary.pendingTool}${nested} (last event ${age} ago)`;
  }
  const seeded =
    typeof summary.lastEventAt === 'number' && typeof summary.lastWorkAt === 'number' && summary.lastEventAt - summary.lastWorkAt > 600000
      ? ` · log written ${formatAge(summary.lastEventAt)} ago (seed/resume)`
      : '';
  return `idle (last work ${age} ago${seeded})`;
}

/**
 * Render board entries.
 * @param entries - announcements, newest first.
 * @returns rendered board.
 */
function renderBoard(entries) {
  if (entries.length === 0) return `The board is empty (${boardFile()}).`;
  const lines = [`Board — ${entries.length} newest (${boardFile()})`];
  for (const entry of entries) {
    lines.push(`${formatStamp(entry.at)}  ${entry.sessionId ? shortId(entry.sessionId) : 'anonymous'}  ${truncate(oneLine(entry.text), 200)}`);
  }
  return lines.join('\n');
}

/**
 * One compact `touched` line for the peers list.
 * @param activity - collected activity, or undefined when none was gathered.
 * @returns the line body, or an empty string when nothing recent was touched.
 */
function renderActivityLine(activity) {
  if (activity === undefined || activity.files.length === 0) return '';
  const shown = activity.files.slice(0, 3).map((file) => {
    const name = file.path.split(/[\\/]/).pop() ?? file.path;
    return file.writes > 0 ? `${name} (w)` : name;
  });
  const verbs = [...new Set(activity.git.map((entry) => entry.verb))];
  return verbs.length > 0 ? `${shown.join(', ')}  · git: ${verbs.join(', ')}` : shown.join(', ');
}

/**
 * Report where two sessions could collide.
 * @param args - tool arguments.
 * @returns rendered overlap report.
 */
async function handleOverlaps(args) {
  const activeWithinMinutes = numberArg(args.active_within_minutes, 240);
  const limit = Math.max(2, Math.round(numberArg(args.limit, 12)));
  const sinceMs = Date.now() - activeWithinMinutes * 60_000;
  const logs = listSessionLogs().filter((log) => log.mtimeMs >= sinceMs).slice(0, limit);
  if (logs.length < 2) {
    return `Only ${logs.length} session had log activity in the last ${activeWithinMinutes} minutes — nothing can collide. Raise active_within_minutes to widen the window.`;
  }
  const rows = logs.map((log) => {
    const peeked = peekSession(log, { headFrames: HEAD_FRAMES, tailFrames: SUMMARY_TAIL_FRAMES });
    return { summary: peeked.summary, activity: collectActivity(peeked.records, { cwd: peeked.summary.cwd, sinceMs }) };
  });
  return renderOverlaps(rows, { activeWithinMinutes });
}

/**
 * Render the overlap report: shared workspaces, git races, shared files.
 * @param rows - one entry per session with its collected activity.
 * @param meta - the look-back window.
 * @returns rendered report.
 */
function renderOverlaps(rows, { activeWithinMinutes }) {
  const lines = [`Cross-session overlap — ${rows.length} sessions with log activity in the last ${activeWithinMinutes}m (now ${formatStamp(Date.now())})`];
  const byWorkspace = new Map();
  for (const row of rows) {
    const key = (row.summary.cwd ?? '(unknown)').toLowerCase();
    byWorkspace.set(key, [...(byWorkspace.get(key) ?? []), row]);
  }
  for (const group of byWorkspace.values()) {
    if (group.length < 2) continue;
    lines.push('', `⚠ same workspace: ${group[0].summary.cwd ?? '(unknown)'}`);
    for (const row of group) {
      const writes = row.activity.files.filter((file) => file.writes > 0).length;
      const reads = row.activity.files.filter((file) => file.reads > 0 && file.writes === 0).length;
      const verbs = [...new Set(row.activity.git.map((entry) => entry.verb))];
      lines.push(`   ${shortId(row.summary.sessionId)}  ${truncate(oneLine(row.summary.title ?? '') || '(no title)', 46)}`);
      lines.push(`       ${describeStatus(row.summary)}`);
      lines.push(`       files: ${writes} written / ${reads} read${verbs.length > 0 ? `  · git: ${verbs.join(', ')}` : ''}`);
    }
    const gitSessions = group.filter((row) => row.activity.git.length > 0).length;
    if (gitSessions > 1) lines.push(`   ⚠ ${gitSessions} sessions ran git here — one add -A / checkout can sweep the other's work`);
  }
  const byFile = new Map();
  for (const row of rows) {
    for (const file of row.activity.files) {
      byFile.set(file.key, [...(byFile.get(file.key) ?? []), { row, file }]);
    }
  }
  const shared = [...byFile.values()].filter((group) => group.length > 1);
  if (shared.length === 0) {
    lines.push('', 'No file was touched by more than one session in this window.');
  } else {
    lines.push('', `⚠ files touched by more than one session (${shared.length}):`);
    for (const group of shared.slice(0, 12)) {
      const writers = group.filter((entry) => entry.file.writes > 0).length;
      lines.push(`   ${writers > 1 ? '⚠ CONFLICT' : '·'} ${truncate(group[0].file.path, 110)}`);
      for (const entry of group) {
        const action = entry.file.writes > 0 ? `wrote x${entry.file.writes}` : `read x${entry.file.reads}`;
        lines.push(`       ${shortId(entry.row.summary.sessionId)}  ${action}  ${formatAge(entry.file.lastAt)} ago`);
      }
    }
  }
  lines.push('', 'Fix: give one session its own git worktree (see the using-git-worktrees skill), or announce which files each session owns.');
  return lines.join('\n');
}

/**
 * Shorten a session id for display.
 * @param sessionId - full session id.
 * @returns the readable short form.
 */
function shortId(sessionId) {
  return String(sessionId ?? '').replace(/^session-/, '').slice(0, 8);
}

/**
 * Format a timestamp in local time.
 * @param ms - epoch milliseconds, or null.
 * @returns `MM-DD HH:MM:SS`, or `--` when unknown.
 */
function formatStamp(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '--';
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Read a numeric tool argument with a fallback.
 * @param value - raw argument value.
 * @param fallback - value used when the argument is absent or not a number.
 * @returns the number to use.
 */
function numberArg(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}


/** Raw tool name to handler. */
const HANDLERS = {
  peers: handlePeers,
  overlaps: handleOverlaps,
  session_detail: handleSessionDetail,
  announce: handleAnnounce,
  board: handleBoard,
  whoami: handleWhoami,
};

/**
 * Execute one tool call.
 * @param name - raw MCP tool name, without the DSH `mcp__<server>__` prefix.
 * @param args - the caller's argument bag.
 * @returns the text rendered for the model.
 */
export async function callTool(name, args = {}) {
  const handler = HANDLERS[name];
  if (handler === undefined) throw new Error(`unknown tool "${name}"`);
  return handler(args ?? {});
}

export { SERVER_NAME, SERVER_VERSION, TOOLS, PUBLIC_NAMES };
