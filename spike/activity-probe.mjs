import { listSessionLogs, readSessionRecords, collectActivity } from '../lib/session-logs.mjs';
const logs = listSessionLogs().slice(0, 3);
for (const log of logs) {
  const read = readSessionRecords(log.file, { headFrames: 1, tailFrames: 60 });
  const cwd = read.records.find((r) => r.type === 'session')?.cwd ?? null;
  const activity = collectActivity(read.records, { cwd, sinceMs: Date.now() - 6 * 3600 * 1000 });
  console.log('=== ' + log.sessionId.slice(8, 16) + '  files=' + activity.files.length + ' git=' + activity.git.length);
  for (const file of activity.files.slice(0, 4)) console.log('    ' + (file.writes ? 'W' : 'r') + file.reads + file.writes + ' ' + file.path);
  for (const entry of activity.git.slice(-3)) console.log('    git ' + entry.verb + ' :: ' + entry.command.slice(0, 70));
}
