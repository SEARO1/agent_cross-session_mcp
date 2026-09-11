/**
 * Tests for the cross-session MCP server.
 *
 * Covers the zstd frame scanner, the session summarizer, caller identification,
 * every tool handler, and — when the sandbox allows spawning a child with pipes —
 * a real stdio round trip through the MCP SDK.
 *
 * Run with: npm test    (scratch files live in .tmp-test/ and are removed at the end)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = path.join(HERE, '.tmp-test');
fs.rmSync(SCRATCH, { recursive: true, force: true });
process.env.CROSS_SESSION_BOARD = path.join(SCRATCH, 'board', 'board.jsonl');

const sessionLogs = await import('./lib/session-logs.mjs');
const board = await import('./lib/board.mjs');
const tools = await import('./lib/tools.mjs');
const { SESSION_LOG_FILENAME, collectActivity, identifyCaller, listSessionLogs, readSessionRecords, scanZstdFrames, summarizeSession, sessionsRoot } = sessionLogs;
const { callTool, TOOLS } = tools;

let passed = 0;
let failed = 0;

/**
 * Run one named test and record its outcome.
 * @param name - test name.
 * @param fn - test body.
 */
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('PASS  ' + name);
  } catch (error) {
    failed += 1;
    console.log('FAIL  ' + name);
    console.log('      ' + (error instanceof Error ? error.message : String(error)));
  }
}

/**
 * Write a synthetic session log built from the given records.
 * @param root - fake sessions root.
 * @param sessionId - session id to create.
 * @param records - records, split into two-record frames.
 * @returns the log file path.
 */
function writeSyntheticSession(root, sessionId, records) {
  const frames = [];
  for (let index = 0; index < records.length; index += 2) {
    const batch = records.slice(index, index + 2).map((record) => JSON.stringify(record)).join('\n') + '\n';
    frames.push(zlib.zstdCompressSync(Buffer.from(batch, 'utf8')));
  }
  const file = path.join(root, '--C-fake--', sessionId, SESSION_LOG_FILENAME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat(frames));
  return file;
}

const now = Date.now();
const fakeRoot = path.join(SCRATCH, 'sessions');
const fakeRecords = [
  { type: 'session', id: 'session-aaaaaaaa-1111-2222-3333-444444444444', cwd: 'C:\\fake\\workspace', createdAt: now - 60000, agentPreset: 'ptc' },
  { type: 'session/title', seq: 1, time: now - 59000, data: { title: 'fake session', source: { kind: 'fallback' } } },
  { type: 'user/message', seq: 2, time: now - 58000, data: { content: [{ type: 'text', text: 'injected context' }], source: { kind: 'plugin' } } },
  { type: 'user/message', seq: 3, time: now - 57000, data: { content: [{ type: 'text', text: 'please refactor the parser' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 4, time: now - 56000, data: { message: { content: [{ type: 'text', text: 'on it' }, { type: 'tool-call' }] } } },
  { type: 'tool/call', seq: 5, time: now - 55000, data: { turn: 1, step: 1, callId: 'call-1', name: 'mcp__crosssession__peers', arguments: '{}' } },
  { type: 'tool/result', seq: 6, time: now - 54000, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call-1' }, content: [] } } },
  { type: 'tool/call', seq: 7, time: now - 53000, data: { turn: 1, step: 2, callId: 'call-2', name: 'run_code', arguments: '{"description":"do work"}' } },
  { type: 'tool/code-dispatch-start', seq: 8, time: now - 52000, data: { rootCallId: 'call-2', parentCallId: 'call-2', subCallId: 'call-2:code:1', name: 'pwsh', arguments: { command: 'ls' } } },
  { type: 'tool/code-dispatch', seq: 9, time: now - 51000, data: { subCallId: 'call-2:code:1', name: 'pwsh', isError: false, content: [] } },
  { type: 'tool/code-dispatch-start', seq: 10, time: now - 50000, data: { rootCallId: 'call-2', parentCallId: 'call-2', subCallId: 'call-2:code:2', name: 'write', arguments: { file_path: 'src/app.ts', content: 'x' } } },
  { type: 'tool/code-dispatch-start', seq: 11, time: now - 49000, data: { rootCallId: 'call-2', parentCallId: 'call-2', subCallId: 'call-2:code:3', name: 'pwsh', arguments: { command: 'git -C repo commit -m "x"' } } },
  { type: 'tool/code-dispatch-start', seq: 12, time: now - 48000, data: { rootCallId: 'call-2', parentCallId: 'call-2', subCallId: 'call-2:code:4', name: 'mcp__crosssession__whoami', arguments: {} } },
];
const FRAME_COUNT = Math.ceil(fakeRecords.length / 2);
const fakeFile = writeSyntheticSession(fakeRoot, 'session-aaaaaaaa-1111-2222-3333-444444444444', fakeRecords);

await test('frame scanner finds every synthetic frame', () => {
  const buffer = fs.readFileSync(fakeFile);
  const scan = scanZstdFrames(buffer);
  assert.equal(scan.frames.length, FRAME_COUNT);
  assert.equal(scan.tornStart, undefined);
  assert.equal(scan.frames[0].start, 0);
  assert.equal(scan.frames[FRAME_COUNT - 1].end, buffer.length);
});

await test('frame scanner reports a torn final frame instead of throwing', () => {
  const buffer = fs.readFileSync(fakeFile);
  const truncated = buffer.subarray(0, buffer.length - 3);
  const scan = scanZstdFrames(truncated);
  assert.equal(scan.frames.length, FRAME_COUNT - 1);
  assert.equal(typeof scan.tornStart, 'number');
});

await test('windowed read decodes head and tail records', () => {
  const read = readSessionRecords(fakeFile, { headFrames: 1, tailFrames: 2 });
  assert.equal(read.frameCount, FRAME_COUNT);
  assert.equal(read.windowed, true);
  assert.equal(read.records[0].type, 'session');
  assert.ok(read.records.some((record) => record.type.startsWith('tool/')));
});

await test('summary keeps the human message and flags the running tool', () => {
  const read = readSessionRecords(fakeFile, { headFrames: 1, tailFrames: 6 });
  const summary = summarizeSession(read.records, { ...read, sessionId: 'session-aaaaaaaa-1111-2222-3333-444444444444' });
  assert.equal(summary.cwd, 'C:\\fake\\workspace');
  assert.equal(summary.title, 'fake session');
  assert.equal(summary.lastUserText, 'please refactor the parser');
  assert.equal(summary.lastAssistantText, 'on it');
  assert.equal(summary.pendingTool, 'run_code');
  assert.equal(summary.pendingNestedTool, 'mcp__crosssession__whoami');
});

await test('activity extraction finds written files and git commands', () => {
  const read = readSessionRecords(fakeFile, { headFrames: 1, tailFrames: 10 });
  const activity = collectActivity(read.records, { cwd: 'C:\\fake\\workspace' });
  const written = activity.files.find((file) => file.writes > 0);
  assert.ok(written, 'expected a written file');
  assert.equal(written.path, 'C:\\fake\\workspace\\src\\app.ts');
  assert.deepEqual(activity.git.map((entry) => entry.verb), ['commit']);
});

await test('overlaps reports without throwing', async () => {
  const text = await callTool('overlaps', { active_within_minutes: 100000, limit: 5 });
  assert.ok(/Cross-session overlap|nothing can collide/.test(text));
});

await test('caller identification matches an in-flight tool call', async () => {
  const caller = await identifyCaller(['mcp__crosssession__peers'], { root: fakeRoot, attempts: 1 });
  assert.ok(caller, 'expected the synthetic call to identify its session');
  assert.equal(caller.sessionId, 'session-aaaaaaaa-1111-2222-3333-444444444444');
  assert.equal(caller.cwd, 'C:\\fake\\workspace');
});

await test('caller identification matches a call made inside run_code', async () => {
  const caller = await identifyCaller(['mcp__crosssession__whoami'], { root: fakeRoot, attempts: 1 });
  assert.ok(caller, 'expected the nested dispatch record to identify its session');
  assert.equal(caller.sessionId, 'session-aaaaaaaa-1111-2222-3333-444444444444');
});

await test('caller identification ignores other servers', async () => {
  const caller = await identifyCaller(['mcp__other__peers'], { root: fakeRoot, attempts: 1 });
  assert.equal(caller, null);
});

await test('every advertised tool has a handler', async () => {
  for (const tool of TOOLS) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 40, tool.name + ' needs a useful description');
    assert.equal(tool.inputSchema.type, 'object');
  }
  await assert.rejects(() => callTool('nope', {}), /unknown tool/);
});

await test('peers renders the live session store', async () => {
  const text = await callTool('peers', { active_within_minutes: 100000, limit: 3 });
  assert.match(text, /DSH sessions/);
  assert.ok(listSessionLogs().length > 0, 'expected session logs in ' + sessionsRoot());
  assert.ok(text.includes('workspace :'), 'expected a workspace line');
});

await test('session_detail renders a real session timeline', async () => {
  const newest = listSessionLogs()[0];
  const text = await callTool('session_detail', { session_id: newest.sessionId, frames: 4, limit: 5 });
  assert.ok(text.includes(newest.sessionId), 'expected the session id in the report');
  assert.match(text, /status    :/);
});

await test('session_detail rejects an unknown id', async () => {
  await assert.rejects(() => callTool('session_detail', { session_id: 'session-nope' }), /no session matches/);
});

await test('announce and board round trip', async () => {
  const posted = await callTool('announce', { text: 'test note from npm test' });
  assert.match(posted, /Posted|anonymous/);
  const listing = await callTool('board', { limit: 5 });
  assert.match(listing, /test note from npm test/);
  assert.equal(board.readAnnouncements({ limit: 1 })[0].text, 'test note from npm test');
});

await test('whoami answers even without a matching call', async () => {
  const text = await callTool('whoami', {});
  assert.ok(text.length > 10);
});

await test('stdio round trip through the MCP SDK', async () => {
  let client;
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(HERE, 'server.mjs')],
      env: { ...process.env },
    });
    client = new Client({ name: 'cross-session-test', version: '0.1.0' });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, TOOLS.length);
    const result = await client.callTool({ name: 'peers', arguments: { active_within_minutes: 100000, limit: 2 } });
    assert.match(result.content[0].text, /DSH sessions/);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/EPERM|spawn|ENOENT/i.test(message)) {
      console.log('SKIP  stdio round trip (sandbox blocked spawning a child: ' + message + ')');
      return;
    }
    throw error;
  } finally {
    if (client) await client.close().catch(() => {});
  }
});

fs.rmSync(SCRATCH, { recursive: true, force: true });
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed === 0 ? 0 : 1;
