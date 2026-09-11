
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
const frames = scanFrames(buf);
const records = [];
for (const f of frames) { try { for (const l of zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8').split('\n')) if (l.trim()) records.push(JSON.parse(l)); } catch {} }
const seen = new Set();
let shown = 0;
for (const r of records) {
  if (seen.has(r.type) || shown > 11) continue;
  seen.add(r.type);
  shown++;
  console.log('### type=' + r.type + ' (frame sample)');
  console.log(JSON.stringify(r).slice(0, 700));
  console.log();
}
console.log('ALL TYPES:', [...new Set(records.map(r => r.type))].join(', '));
