// Local Pi IPC, following the Herdr Plannotator pipe transport. Messages reach
// Pi's API, never terminal input which could otherwise race into a shell.
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const MESSAGE_LIMIT = 256 * 1024;
const timeout = 10000;

export async function startAgentIpc({ pid, session, validate, submit, report = (_error) => {} }) {
  const token = randomBytes(32).toString('hex');
  const directory = process.platform === 'win32' ? undefined : await mkdtemp(path.join(tmpdir(), 'herdr-agent-'));
  const socket = directory ? path.join(directory, 'agent.sock') : `\\\\.\\pipe\\herdr-agent-${pid}-${token}`;
  const clients = new Set(), ledger = new Map();
  let stopped = false;
  const server = net.createServer(client => {
    clients.add(client); client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.setTimeout(timeout, () => client.destroy()); client.setEncoding('utf8');
    let input = '', processing = false;
    client.on('data', async chunk => {
      if (processing) return;
      input += chunk;
      if (Buffer.byteLength(input) > MESSAGE_LIMIT) { client.destroy(); return; }
      const newline = input.indexOf('\n');
      if (newline === -1) return;
      processing = true; client.pause();
      const send = result => { if (!client.destroyed) client.end(`${JSON.stringify(result)}\n`, () => client.destroy()); };
      let request;
      try { request = JSON.parse(input.slice(0, newline)); }
      catch { send({ error: 'Invalid Pi message request' }); return; }
      if (request?.token !== token || request.pid !== pid || request.session !== session) {
        send({ error: 'The Pi message identity changed; inspect the agent again' }); return;
      }
      if (typeof request.id !== 'string' || !request.id || request.id.length > 128 || typeof request.message !== 'string' || !request.message.trim()) {
        send({ error: 'A message request needs an ID and non-empty text' }); return;
      }
      for (const [id, entry] of ledger) if (entry.done && entry.expires < Date.now()) ledger.delete(id);
      let entry = ledger.get(request.id);
      if (entry && entry.message !== request.message) { send({ error: 'This message ID already contains different text' }); return; }
      if (!entry) {
        if (ledger.size >= 256) { send({ error: 'The Pi message queue is full; no message was submitted' }); return; }
        entry = { message: request.message, expires: Date.now() + 120000, done: false };
        // Claim before awaiting validation; concurrent identical requests share
        // the same result instead of submitting the follow-up a second time.
        ledger.set(request.id, entry);
        entry.result = Promise.resolve().then(async () => {
          await validate();
          if (stopped) throw new Error('The Pi message route changed during reload; inspect the agent');
          // submit is synchronous: Pi queues the follow-up in its own event
          // loop. Do not wait for the next model response before acknowledging.
          submit(request.message);
          return { outcome: 'submitted' };
        }).catch(error => ({ error: error instanceof Error ? error.message : String(error) })).finally(() => { entry.done = true; });
      }
      send(await entry.result);
    });
  });
  server.maxConnections = 32;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, () => { server.removeListener('error', reject); resolve(); }); });
    if (directory) await chmod(socket, 0o600);
  } catch (error) { server.close(); if (directory) await rm(directory, { recursive: true, force: true }); throw error; }
  server.on('error', report);
  return { socket, token,
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const client of clients) client.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}

export function requestAgentMessage({ socket, token }, request) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let input = '';
    client.setEncoding('utf8'); client.setTimeout(timeout, () => client.destroy(new Error('The Pi did not confirm the message; do not resend it automatically')));
    client.on('error', reject);
    client.on('connect', () => client.write(`${JSON.stringify({ ...request, token })}\n`));
    client.on('data', chunk => { input += chunk; if (Buffer.byteLength(input) > MESSAGE_LIMIT) client.destroy(new Error('The Pi message confirmation is too large')); });
    client.on('end', () => {
      try { resolve(JSON.parse(input)); }
      catch { reject(new Error('The Pi returned no message confirmation; do not resend it automatically')); }
      finally { client.destroy(); }
    });
  });
}
