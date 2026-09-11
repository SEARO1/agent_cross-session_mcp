/**
 * Read-only access to DSH session logs.
 *
 * A DSH session log is a *container*: a concatenation of independent
 * Zstandard frames, each holding one batch of JSONL records. DSH appends
 * frames while the session runs, so an external process can watch live
 * activity without touching DSH itself.
 *
 * Node's `zstdDecompressSync` decodes only the first frame of such a container, so
 * frames are located structurally first (frame header, then block headers)
 * and decoded one at a time.
 *
 * Layout: `<sessionsRoot>/<sanitized-cwd>/<session-id>/session.v2.jsonl.zstd`
 *
 * @module cross-session/session-logs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/** Little-endian Zstandard frame magic (0xFD2FB528). */
export const ZSTD_FRAME_MAGIC = 0xfd2fb528;

/** File name of one session's durable log inside its session directory. */
export const SESSION_LOG_FILENAME = 'session.v2.jsonl.zstd';

/** Human messages carry this `data.source.kind`; everything else is injected. */
const HUMAN_SOURCE_KIND = 'user';

/**
 * Resolve the session store root.
 * @returns the `sessions` directory of the active DSH home.
 */
export function sessionsRoot() {
  if (process.env.DSH_SESSIONS_DIR) return process.env.DSH_SESSIONS_DIR;
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'sessions');
}

/**
 * Locate every complete Zstandard frame in a session-log container.
 *
 * Blocks are walked through their headers only: a compressed block stores its
 * compressed length in the block header, so finding the next frame needs no
 * decompression. A trailing partial frame (a write in progress) is reported
 * as `tornStart` instead of failing.
 *
 * @param buffer - the bytes currently present in the session artifact.
 * @param maxFrames - optional cap on located frames.
 * @returns complete frame ranges, plus the start of a torn final frame.
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_FRAME_MAGIC) {
      throw new Error(`invalid zstd frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < headerBytes) return { frames, tornStart: start };
    offset += headerBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved zstd block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length >= maxFrames) return { frames };
  }
  return { frames };
}

/**
 * List every session log on disk, newest first.
 * @param root - session store root; defaults to {@link sessionsRoot}.
 * @returns one descriptor per session log.
 */
export function listSessionLogs(root = sessionsRoot()) {
  const logs = [];
  let workspaceDirs;
  try {
    workspaceDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return logs;
  }
  for (const workspaceDir of workspaceDirs) {
    if (!workspaceDir.isDirectory()) continue;
    const workspacePath = path.join(root, workspaceDir.name);
    let sessionDirs;
    try {
      sessionDirs = fs.readdirSync(workspacePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      const file = path.join(workspacePath, sessionDir.name, SESSION_LOG_FILENAME);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      logs.push({ sessionId: sessionDir.name, file, mtimeMs: stat.mtimeMs, bytes: stat.size });
    }
  }
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return logs;
}

/**
 * Read a bounded window of one session log.
 *
 * Only the head frames (session header, title) and the newest frames (current
 * activity) are decoded, which keeps a poll of every session cheap even when
 * a log has grown to hundreds of frames.
 *
 * @param file - absolute path to a `session.v2.jsonl.zstd`.
 * @param options - window sizes; `tailFrames` covers the recent activity.
 * @returns decoded records plus container metadata.
 */
export function readSessionRecords(file, { headFrames = 1, tailFrames = 6 } = {}) {
  const buffer = fs.readFileSync(file);
  const { frames, tornStart } = scanZstdFrames(buffer);
  const head = frames.slice(0, Math.max(headFrames, 0));
  const tail = frames.slice(Math.max(frames.length - tailFrames, head.length));
  const records = [];
  let decodedFrameCount = 0;
  for (const frame of [...head, ...tail]) {
    let text;
    try {
      text = zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8');
    } catch {
      continue;
    }
    decodedFrameCount += 1;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // A torn or partially written line is skipped; the next poll rereads it.
      }
    }
  }
  return {
    records,
    frameCount: frames.length,
    decodedFrameCount,
    windowed: head.length + tail.length < frames.length,
    torn: tornStart !== undefined,
    bytes: buffer.length,
    mtimeMs: fs.statSync(file).mtimeMs,
  };
}

/**
 * Collapse one session's records into the activity facts a peer cares about.
 * @param records - decoded records, oldest first.
 * @param meta - container metadata from {@link readSessionRecords}.
 * @returns the session header plus its latest activity.
 */
export function summarizeSession(records, meta = {}) {
  const summary = {
    sessionId: meta.sessionId ?? null,
    cwd: null,
    title: null,
    titleSource: null,
    agentPreset: null,
    createdAt: null,
    lastEventAt: meta.mtimeMs ?? null,
    lastWorkAt: null,
    lastUserText: null,
    lastUserAt: null,
    lastAssistantText: null,
    lastAssistantAt: null,
    pendingTool: null,
    pendingNestedTool: null,
    pendingSince: null,
    lastTool: null,
    frameCount: meta.frameCount ?? 0,
    bytes: meta.bytes ?? 0,
    mtimeMs: meta.mtimeMs ?? null,
  };
  const resolvedCalls = new Set();
  let lastCall = null;
  let lastCallAt = null;
  let dispatchId = null;
  let dispatchName = null;
  for (const record of records) {
    const { type, data, time } = record;
    if (typeof time === 'number') {
      summary.lastEventAt = time;
      if (isWorkRecord(type, data)) summary.lastWorkAt = time;
    }
    if (type === 'session') {
      summary.sessionId = record.id ?? summary.sessionId;
      summary.cwd = record.cwd ?? null;
      summary.createdAt = record.createdAt ?? null;
      summary.agentPreset = record.agentPreset ?? null;
    } else if (type === 'session/title') {
      summary.title = data?.title ?? null;
      summary.titleSource = data?.source?.kind ?? null;
    } else if (type === 'user/message') {
      if (data?.source?.kind !== HUMAN_SOURCE_KIND) continue;
      const text = textOfContent(data.content);
      if (!text) continue;
      summary.lastUserText = text;
      summary.lastUserAt = time ?? null;
    } else if (type === 'assistant/message') {
      const text = textOfContent(data?.message?.content ?? data?.content);
      if (!text) continue;
      summary.lastAssistantText = text;
      summary.lastAssistantAt = time ?? null;
    } else if (type === 'tool/call') {
      lastCall = { callId: data?.callId ?? null, name: data?.name ?? 'unknown' };
      lastCallAt = time ?? null;
      summary.lastTool = lastCall.name;
    } else if (type === 'tool/code-dispatch-start') {
      dispatchId = data?.subCallId ?? null;
      dispatchName = data?.name ?? null;
    } else if (type === 'tool/code-dispatch') {
      if (data?.subCallId !== undefined && data.subCallId === dispatchId) {
        dispatchId = null;
        dispatchName = null;
      }
    } else if (type === 'tool/result') {
      const callId = data?.message?.source?.callId ?? null;
      if (callId !== null) resolvedCalls.add(callId);
    }
  }
  if (lastCall !== null && lastCall.callId !== null && !resolvedCalls.has(lastCall.callId)) {
    summary.pendingTool = lastCall.name;
    summary.pendingNestedTool = dispatchName;
    summary.pendingSince = lastCallAt;
  }
  return summary;
}

/**
 * Whether a record means the session or its human actually did something.
 *
 * Session files are also written when DSH seeds or resumes a session, so the
 * file mtime alone would make a dormant session look active.
 *
 * @param type - record type.
 * @param data - record payload.
 * @returns @@BT@@true@@BT@@ for human messages, replies, and tool calls.
 */
function isWorkRecord(type, data) {
  if (type === 'assistant/message' || type === 'tool/call' || type === 'tool/code-dispatch-start') return true;
  if (type === 'user/message') return data?.source?.kind === HUMAN_SOURCE_KIND;
  return false;
}

/**
 * Read and summarize one session in a single step.
 * @param log - descriptor from {@link listSessionLogs}.
 * @param options - window sizes for {@link readSessionRecords}.
 * @returns container metadata plus `summary` and `records`.
 */
export function peekSession(log, options = {}) {
  const read = readSessionRecords(log.file, options);
  return {
    ...read,
    summary: summarizeSession(read.records, { ...read, sessionId: log.sessionId }),
  };
}

/**
 * Build the recent activity timeline of one session, oldest first.
 * @param records - decoded records, oldest first.
 * @param limit - maximum number of timeline entries kept (the newest ones).
 * @returns timeline entries with `at`, `kind`, and rendered `text`.
 */
export function buildTimeline(records, limit = 30) {
  const entries = [];
  for (const record of records) {
    const { type, data, time } = record;
    if (type === 'user/message') {
      if (data?.source?.kind !== HUMAN_SOURCE_KIND) continue;
      const text = textOfContent(data.content);
      if (text) entries.push({ at: time ?? null, kind: 'user', text });
    } else if (type === 'assistant/message') {
      const text = textOfContent(data?.message?.content ?? data?.content);
      if (text) entries.push({ at: time ?? null, kind: 'assistant', text });
    } else if (type === 'tool/call') {
      entries.push({ at: time ?? null, kind: 'tool', text: renderToolCall(data) });
    }
  }
  return entries.slice(-limit);
}

/**
 * Name the session that is calling one of our own MCP tools right now.
 *
 * DSH does not forward a session identity to MCP servers, but it appends the caller's
 * `tool/call` (or `tool/code-dispatch-start` for a call made inside `run_code`) to its log
 * *before* the call is served, so a matching record identifies the caller exactly.
 *
 * @param publicNames - fully qualified tool names, e.g. `mcp__crosssession__peers`.
 * @param options - search window and retry policy.
 * @returns the matching call, or `null` when nothing matched in time.
 */
export async function identifyCaller(publicNames, { root = sessionsRoot(), withinMs = 120000, attempts = 4, delayMs = 250 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const caller = findNewestMatchingCall(publicNames, root, withinMs);
    if (caller !== null) return caller;
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return null;
}

/**
 * Scan recent session logs for the newest call to one of our tools.
 * @param publicNames - fully qualified tool names to match.
 * @param root - session store root.
 * @param withinMs - how far back a matching call still counts.
 * @returns the matching call, or `null`.
 */
function findNewestMatchingCall(publicNames, root, withinMs) {
  const cutoff = Date.now() - withinMs;
  let best = null;
  for (const log of listSessionLogs(root)) {
    if (log.mtimeMs < cutoff) continue;
    let read;
    try {
      read = readSessionRecords(log.file, { headFrames: 1, tailFrames: 8 });
    } catch {
      continue;
    }
    const header = read.records.find((record) => record.type === 'session');
    for (const record of read.records) {
      const name = recordToolName(record);
      if (name === null || !publicNames.includes(name)) continue;
      const at = typeof record.time === 'number' ? record.time : log.mtimeMs;
      if (at < cutoff) continue;
      if (best === null || at > best.at) {
        best = { sessionId: log.sessionId, cwd: header?.cwd ?? null, tool: name, at };
      }
    }
  }
  return best;
}

/**
 * Extract the tool call one record describes.
 *
 * A tool the model calls itself is a `tool/call` record whose `arguments` are a JSON
 * string; the same tool called from inside `run_code` is a
 * `tool/code-dispatch-start` record whose `arguments` are already an object.
 *
 * @param record - one session-log record.
 * @returns the call, or `null` for every other record type.
 */
export function toolCallOf(record) {
  if (record.type !== 'tool/call' && record.type !== 'tool/code-dispatch-start') return null;
  const raw = record.data?.arguments;
  let args = null;
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw);
    } catch {
      args = null;
    }
  } else if (raw !== null && typeof raw === 'object') {
    args = raw;
  }
  return { name: record.data?.name ?? null, args, at: typeof record.time === 'number' ? record.time : null };
}

/** Tools whose call means the session is writing that file. */
const WRITING_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'write_file', 'apply_patch']);

/**
 * Collect the file and git activity inside one session window.
 *
 * Paths are resolved against the session workspace, so a relative
 * `lib/tools.mjs` and an absolute path to the same file collapse into one key.
 *
 * @param records - decoded records, oldest first.
 * @param options - `cwd` resolves relative paths; `sinceMs` drops older calls.
 * @returns touched files (newest first) and the git subcommands this session ran.
 */
export function collectActivity(records, { cwd = null, sinceMs = null } = {}) {
  const files = new Map();
  const git = [];
  for (const record of records) {
    const call = toolCallOf(record);
    if (call === null) continue;
    if (sinceMs !== null && (call.at ?? 0) < sinceMs) continue;
    const args = call.args ?? {};
    const target = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : null;
    if (target !== null && call.name !== null) {
      const resolved = path.resolve(cwd ?? process.cwd(), target);
      const key = resolved.toLowerCase();
      const entry = files.get(key) ?? { key, path: resolved, reads: 0, writes: 0, lastAt: null, tools: new Set() };
      if (WRITING_TOOLS.has(call.name)) entry.writes += 1;
      else entry.reads += 1;
      if (call.at !== null && (entry.lastAt === null || call.at > entry.lastAt)) entry.lastAt = call.at;
      entry.tools.add(call.name);
      files.set(key, entry);
    }
    const command = typeof args.command === 'string' ? args.command : null;
    const verb = command === null ? null : gitVerb(command);
    if (verb !== null) git.push({ verb, command: oneLine(command).slice(0, 140), at: call.at });
  }
  return {
    files: [...files.values()]
      .map((entry) => ({ ...entry, tools: [...entry.tools] }))
      .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)),
    git,
  };
}

/**
 * Read the git subcommand out of one shell command line.
 * @param command - the raw command text.
 * @returns the subcommand, or `null` when the command never calls git.
 */
function gitVerb(command) {
  const tokens = oneLine(command).split(' ');
  const start = tokens.findIndex((token) => token === 'git' || /(^|[\\/])git(\.exe)?$/.test(token));
  if (start < 0) return null;
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '') continue;
    if (token === '-C' || token === '-c' || token === '--git-dir') {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token.replace(/["']/g, '').toLowerCase();
  }
  return null;
}

/**
 * The tool name of a direct or programmatic call record.
 *
 * A tool the model calls itself is written as `tool/call`; the same tool called from
 * inside `run_code` is written as `tool/code-dispatch-start`. Both identify the
 * calling session.
 *
 * @param record - one session-log record.
 * @returns the tool name, or `null` for every other record type.
 */
function recordToolName(record) {
  return toolCallOf(record)?.name ?? null;
}

/** Concatenate the text parts of one message content array. */
export function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/** Render one `tool/call` as a compact single line. */
function renderToolCall(data) {
  const name = data?.name ?? 'unknown';
  const raw = typeof data?.arguments === 'string' ? data.arguments : '';
  let hint = raw;
  try {
    const parsed = JSON.parse(raw);
    hint = parsed.description ?? parsed.command ?? parsed.file_path ?? parsed.query ?? parsed.prompt ?? raw;
  } catch {
    // Leave the raw argument text as the hint.
  }
  const compact = oneLine(String(hint ?? ''));
  return compact ? `${name}: ${truncate(compact, 160)}` : name;
}

/** Collapse all whitespace runs into single spaces. */
export function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Truncate text to `max` characters, marking the cut. */
export function truncate(text, max = 200) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Render a duration in milliseconds as a compact age such as `3m`. */
export function formatAge(from, to = Date.now()) {
  if (typeof from !== 'number' || !Number.isFinite(from)) return 'unknown';
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ''}`;
}

/** Sleep for a number of milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
