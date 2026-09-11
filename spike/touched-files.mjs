/** Spike: can we tell which files each session touched, from the log tail? */
import { listSessionLogs, readSessionRecords } from '../lib/session-logs.mjs';

const logs = listSessionLogs().slice(0, 4);
for (const log of logs) {
  const read = readSessionRecords(log.file, { headFrames: 1, tailFrames: 60 });
  const files = new Map();
  const commands = [];
  for (const record of read.records) {
    let name = null;
    let args = null;
    if (record.type === 'tool/call') { name = record.data?.name; try { args = JSON.parse(record.data?.arguments ?? '{}'); } catch { args = null; } }
    else if (record.type === 'tool/code-dispatch-start') { name = record.data?.name; args = record.data?.arguments ?? null; }
    if (name === null || args === null) continue;
    const target = args.file_path ?? args.path ?? null;
    if (typeof target === 'string') {
      const key = name + '|' + target;
      files.set(key, (files.get(key) ?? 0) + 1);
    }
    const command = args.command ?? null;
    if (typeof command === 'string' && /\bgit\b/.test(command)) commands.push(command.split('\n')[0].slice(0, 90));
  }
  console.log('=== ' + log.sessionId.slice(8, 16) + '  (' + Math.round((Date.now() - log.mtimeMs) / 60000) + 'm ago, tail ' + read.decodedFrameCount + ' frames)');
  for (const [key, count] of files) console.log('    ' + key + '   x' + count);
  for (const command of commands.slice(-5)) console.log('    git> ' + command);
  if (files.size === 0 && commands.length === 0) console.log('    (tail window 冇 file-path 操作)');
}