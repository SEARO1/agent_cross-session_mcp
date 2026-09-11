
// Spike: multi-frame zstd session-log reader + activity summary (design validation only)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ZSTD_MAGIC = 0xfd2fb528;

function scanFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('bad magic at ' + offset);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset); offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('reserved block type at ' + (offset - 3));
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
  }
  return { frames };
}

function readRecords(file) {
  const buf = fs.readFileSync(file);
  const { frames, tornStart } = scanFrames(buf);
  const out = [];
  for (const f of frames) {
    let text;
    try { text = zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8'); }
    catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  }
  return { records: out, frames: frames.length, torn: tornStart !== undefined, bytes: buf.length };
}

function textOf(v) { return typeof v === 'string' ? v : ''; }

function summarize(file) {
  const { records, frames } = readRecords(file);
  const st = { id: null, cwd: null, title: null, lastUser: '', lastAssistant: '', pendingTool: null, lastTs: null, turns: 0, events: records.length };
  for (const r of records) {
    const t = r.type;
    if (t === 'session') { st.id = r.id; st.cwd = r.cwd; }
    else if (t === 'session/title') st.title = r.data?.title ?? r.title ?? null;
    else if (t === 'user/message') {
      const parts = r.data?.content ?? [];
      const txt = parts.filter(p => p.type === 'text').map(p => textOf(p.text)).join(' ');
      if (r.data?.source?.kind === 'user' && txt.trim()) st.lastUser = txt.trim();
    } else if (t === 'assistant/message') {
      const parts = r.data?.message?.content ?? [];
      const txt = parts.filter(p => p.type === 'text').map(p => textOf(p.text)).join(' ').trim();
      if (txt) st.lastAssistant = txt;
    } else if (t === 'tool/call') st.pendingTool = r.data?.name ?? r.name ?? 'tool';
    else if (t === 'tool/result') st.pendingTool = null;
    else if (t === 'turn/start') st.turns++;
    if (r.time) st.lastTs = r.time;
  }
  return { st, frames };
}

const root = 'C:\\Users\\cheun\\.dsh\\sessions';
const rows = [];
for (const wsDir of fs.readdirSync(root)) {
  const wsPath = path.join(root, wsDir);
  if (!fs.statSync(wsPath).isDirectory()) continue;
  for (const sid of fs.readdirSync(wsPath)) {
    const f = path.join(wsPath, sid, 'session.v2.jsonl.zstd');
    if (!fs.existsSync(f)) continue;
    const mtime = fs.statSync(f).mtimeMs;
    rows.push({ f, mtime, sid });
  }
}
rows.sort((a, b) => b.mtime - a.mtime);
const now = Date.now();
console.log('sessions on disk:', rows.length);
for (const r of rows.slice(0, 6)) {
  const { st, frames } = summarize(r.f);
  const ageMin = ((now - r.mtime) / 60000).toFixed(1);
  console.log('---');
  console.log('  id      :', st.id);
  console.log('  cwd     :', st.cwd);
  console.log('  title   :', (st.title ?? '').slice(0, 60));
  console.log('  mtime   :', ageMin + ' min ago | frames=' + frames + ' | turns=' + st.turns + ' | records=' + st.events);
  console.log('  busy    :', st.pendingTool ? ('RUNNING ' + st.pendingTool) : 'idle');
  console.log('  lastUser:', st.lastUser.slice(0, 100).replace(/\s+/g, ' '));
  console.log('  lastAsst:', st.lastAssistant.slice(0, 100).replace(/\s+/g, ' '));
}
