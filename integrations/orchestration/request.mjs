#!/usr/bin/env node
// machine.exec helper: request.mjs <terminal-id> <pid> <session> <hc-path>.
// Read the message from stdin; never interpolate task text into a shell/argv.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MESSAGE_LIMIT, requestAgentMessage } from './ipc.mjs';

export function reachable(record, pid, session) {
  let label;
  try { label = JSON.parse(record?.labels?.['herdr.pi'] ?? 'null'); } catch { return null; }
  return record?.state === 'live' && record.foreground?.pid === pid && label?.version === 1 && label.pid === pid && label.session === session
    && ['socket', 'token', 'node', 'request', 'hc'].every(key => typeof label[key] === 'string' && label[key]) ? label : null;
}

async function main([terminal, rawPid, session, hc = process.env.HC_BIN || 'hc']) {
  const pid = Number(rawPid);
  if (!terminal || !Number.isSafeInteger(pid) || pid <= 0 || !session) throw new Error('A Pi message needs an exact terminal, PID and session');
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > MESSAGE_LIMIT - 1024) throw new Error('The Pi follow-up message is too large'); }
  let envelope;
  try { envelope = JSON.parse(input); } catch { throw new Error('Invalid Pi follow-up message'); }
  if (typeof envelope.message !== 'string' || !envelope.message.trim()) throw new Error('The Pi follow-up message is empty');
  let record;
  try { record = JSON.parse(execFileSync(hc, ['get', terminal, '--json'], { encoding: 'utf8', timeout: 5000, windowsHide: true })); }
  catch { throw new Error('Cannot verify the target Pi; no message was submitted'); }
  const route = reachable(record, pid, session);
  if (!route) throw new Error('The Pi identity or message route changed; inspect the agent and reload Pi');
  let result;
  try { result = await requestAgentMessage(route, { id: randomUUID(), pid, session, message: envelope.message }); }
  catch { throw new Error('Pi message delivery was not confirmed; inspect the agent before resending'); }
  if (result?.outcome !== 'submitted') throw new Error(result?.error || 'The Pi session did not confirm message submission');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : 'Pi message delivery failed'); process.exitCode = 1; });
}
