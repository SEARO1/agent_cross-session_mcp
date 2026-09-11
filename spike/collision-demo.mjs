import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
const root = path.join(process.cwd(), '.tmp-demo', 'sessions');
fs.rmSync(path.dirname(root), { recursive: true, force: true });
function writeSession(id, title, calls) {
  const records = [
    { type: 'session', id, cwd: 'C:\\demo\\repo', createdAt: Date.now() - 600000 },
    { type: 'session/title', seq: 1, time: Date.now() - 590000, data: { title, source: { kind: 'fallback' } } },
    { type: 'user/message', seq: 2, time: Date.now() - 580000, data: { content: [{ type: 'text', text: title }], source: { kind: 'user' } } },
    ...calls,
  ];
  const frames = [];
  for (let i = 0; i < records.length; i += 2) {
    const batch = records.slice(i, i + 2).map((r) => JSON.stringify(r)).join('\n') + '\n';
    frames.push(zlib.zstdCompressSync(Buffer.from(batch, 'utf8')));
  }
  const dir = path.join(root, '--C-demo-repo--', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.v2.jsonl.zstd'), Buffer.concat(frames));
}
const call = (seq, name, args) => ({ type: 'tool/code-dispatch-start', seq, time: Date.now() - (60000 - seq * 1000), data: { subCallId: 'c' + seq, name, arguments: args } });
writeSession('session-aaaa1111-0000-0000-0000-000000000001', '重構 dashboard', [
  call(3, 'write', { file_path: 'src/dashboard.tsx', content: 'x' }),
  call(4, 'pwsh', { command: 'git add -A' }),
  call(5, 'pwsh', { command: 'git commit -m "refactor dashboard"' }),
]);
writeSession('session-bbbb2222-0000-0000-0000-000000000002', '修 dashboard bug', [
  call(3, 'edit', { file_path: 'src/dashboard.tsx', content: 'y' }),
  call(4, 'pwsh', { command: 'git commit -m "fix bug"' }),
]);
process.env.DSH_SESSIONS_DIR = root;
const { callTool } = await import('../lib/tools.mjs');
console.log(await callTool('overlaps', { active_within_minutes: 60, limit: 6 }));
fs.rmSync(path.dirname(root), { recursive: true, force: true });