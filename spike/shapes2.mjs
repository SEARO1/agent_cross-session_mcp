
import fs from 'node:fs';
import zlib from 'node:zlib';
const ZSTD_MAGIC = 0xfd2fb528;
function scanFrames(buffer) {
  const frames = []; let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return frames;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('bad magic ' + offset);
    offset += 4;
    if (offset === buffer.length) return frames;
    const d = buffer.readUInt8(offset); offset += 1;
    const csf = d >>> 6, ss = (d & 32) !== 0, ck = (d & 4) !== 0, df = d & 3;
    const remaining = (ss ? 0 : 1) + (df === 3 ? 4 : df) + (csf === 0 ? (ss ? 1 : 0) : 1 << csf);
    if (buffer.length - offset < remaining) return frames;
    offset += remaining;
    for (;;) {
      if (buffer.length - offset < 3) return frames;
      const bh = buffer.readUIntLE(offset, 3); offset += 3;
      const last = (bh & 1) !== 0, type = (bh >>> 1) & 3, size = bh >>> 3;
      const payload = type === 1 ? 1 : size;
      if (buffer.length - offset < payload) return frames;
      offset += payload;
      if (last) break;
    }
    if (ck) { if (buffer.length - offset < 4) return frames; offset += 4; }
    frames.push({ start, end: offset });
  }
  return frames;
}
const file = process.argv[2];
const buf = fs.readFileSync(file);
const records = [];
for (const f of scanFrames(buf)) { try { for (const l of zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8').split('\n')) if (l.trim()) records.push(JSON.parse(l)); } catch {} }
function show(type, pred = () => true, n = 2, max = 900) {
  let c = 0;
  for (const r of records) { if (r.type !== type || !pred(r)) continue; console.log('### ' + type); console.log(JSON.stringify(r).slice(0, max)); console.log(); if (++c >= n) break; }
}
show('user/message', r => r.data?.source?.kind === 'user', 2, 600);
show('assistant/message', r => (r.data?.message?.content ?? []).some(p => p.type === 'text'), 1, 900);
show('tool/call', () => true, 2, 500);
show('tool/result', () => true, 1, 500);
console.log('--- distinct user/message source kinds:', [...new Set(records.filter(r=>r.type==='user/message').map(r => r.data?.source?.kind ?? '(none)'))].join(', '));
console.log('--- last record type:', records[records.length-1]?.type, 'seq', records[records.length-1]?.seq);
