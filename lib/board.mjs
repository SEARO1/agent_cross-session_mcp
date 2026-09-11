/**
 * The shared cross-session board.
 *
 * One append-only JSONL file under the DSH home that every session may post to.
 * A line is written with a single `appendFileSync` call, so concurrent sessions never
 * interleave one announcement; the reader tolerates a torn final line.
 *
 * Location: `<DSH_HOME>/cross-session/board.jsonl` (override: `CROSS_SESSION_BOARD`)
 *
 * @module cross-session/board
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Compact the board once it grows past this size. */
const MAX_BOARD_BYTES = 1024 * 1024;
/** Announcements kept when compacting. */
const KEEP_LINES = 500;

/**
 * Resolve the board file path.
 * @returns the absolute path of the announcement log.
 */
export function boardFile() {
  if (process.env.CROSS_SESSION_BOARD) return process.env.CROSS_SESSION_BOARD;
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'cross-session', 'board.jsonl');
}

/**
 * Append one announcement to the board.
 * @param entry - announcement fields; `at` defaults to now.
 * @returns the stored announcement.
 */
export function appendAnnouncement({ sessionId = null, cwd = null, text, at = Date.now() }) {
  const file = boardFile();
  const record = { at, sessionId, cwd, text: String(text ?? '').trim() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  compactIfLarge(file);
  return record;
}

/**
 * Read announcements, newest first.
 * @param options - `limit` caps the result, `sinceMs` drops older entries.
 * @returns parsed announcements.
 */
export function readAnnouncements({ limit = 20, sinceMs = null } = {}) {
  const file = boardFile();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (sinceMs !== null && typeof parsed.at === 'number' && parsed.at < sinceMs) continue;
    entries.push(parsed);
  }
  return entries.slice(-limit).reverse();
}

/**
 * Rewrite the board with only its newest lines once it exceeds the size cap.
 * @param file - board path.
 */
function compactIfLarge(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  if (stat.size <= MAX_BOARD_BYTES) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${lines.slice(-KEEP_LINES).join('\n')}\n`, 'utf8');
  fs.renameSync(temp, file);
}
