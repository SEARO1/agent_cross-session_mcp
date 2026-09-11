
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const buf = fs.readFileSync(file);
console.log('file bytes:', buf.length);

// Strategy 1: single-shot decompress
let one = 0;
try { one = zlib.zstdDecompressSync(buf).length; } catch (e) { one = -1; }
console.log('single-shot decompressed bytes:', one);

// Strategy 2: split on zstd frame magic 28 B5 2F FD
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offs = [];
let i = 0;
while (true) {
  const k = buf.indexOf(magic, i);
  if (k < 0) break;
  offs.push(k); i = k + 4;
}
console.log('frame magic occurrences:', offs.length, 'first offsets:', offs.slice(0, 8));

// Strategy 3: streaming decompress over the whole buffer (handles concatenated frames?)
const chunks = [];
await new Promise((res, rej) => {
  const d = zlib.createZstdDecompress();
  d.on('data', c => chunks.push(c));
  d.on('end', res); d.on('error', rej);
  d.end(buf);
});
const streamed = Buffer.concat(chunks);
console.log('streamed decompressed bytes:', streamed.length);

const text = streamed.toString('utf8');
const lines = text.split('\n').filter(Boolean);
console.log('jsonl lines:', lines.length);
const types = {};
for (const l of lines) { try { const o = JSON.parse(l); const t = o.type ?? o.kind ?? '?'; types[t] = (types[t]||0)+1; } catch { types['<bad>'] = (types['<bad>']||0)+1; } }
console.log('record types:', JSON.stringify(types));
console.log('--- last 3 lines (truncated) ---');
for (const l of lines.slice(-3)) console.log(l.slice(0, 400));
