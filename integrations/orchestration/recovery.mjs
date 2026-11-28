import { createHash, randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const activeKey = Symbol.for('herdr.orchestration.recovery.active');
const active = globalThis[activeKey] ??= new Set();
const ownerKey = Symbol.for('herdr.orchestration.recovery.owner-locks');
const owners = globalThis[ownerKey] ??= new Map();
const validId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
const digest = value => createHash('sha256').update(value).digest('hex');
export const receiptName = id => `hr.${digest(id).slice(0, 28)}`;
const mayBeAlive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};

// SQLite transactions serialize admission and acknowledgement across Pi processes.
// SQLite releases its OS locks on crash, without an age-based stale-lock guess.
export class RecoveryJournal {
  constructor(root, session, { limit = 256 } = {}) {
    this.session = session;
    this.dir = root;
    this.file = path.join(root, 'recovery.sqlite');
    this.limit = limit;
    this.active = active;
    this.created = new Set();
  }
  async database() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.file);
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, session TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_session ON requests(session);
      CREATE TABLE IF NOT EXISTS acknowledgements (id TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(id, revision));
      CREATE TABLE IF NOT EXISTS cleanup (id TEXT PRIMARY KEY, session TEXT NOT NULL, receipt TEXT NOT NULL);`);
    return db;
  }
  ownerFile(id) { return path.join(this.dir, `owner-${id}.sqlite`); }
  async removeOwnerFile(id) {
    try { await unlink(this.ownerFile(id)); }
    catch (error) { if (error.code !== 'ENOENT') console.warn(`Cannot remove Herdr recovery owner lock: ${error.message}`); }
  }
  async holdOwner(id) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.ownerFile(id));
    try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); owners.set(id, db); }
    catch (error) { db.close(); throw error; }
  }
  async releaseOwner(id) {
    const db = owners.get(id);
    if (db) {
      owners.delete(id);
      db.close();
      await this.removeOwnerFile(id);
    }
  }
  ownerAlive(value) {
    if (!value.ownerLock) return mayBeAlive(value.ownerPid); // Entries from older versions.
    try { statSync(this.ownerFile(value.id)); }
    catch (error) { return error.code !== 'ENOENT'; }
    let db;
    try {
      db = new DatabaseSync(this.ownerFile(value.id));
      db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK');
      return false;
    } catch { return true; } // An I/O error is not evidence that the owner died.
    finally { db?.close(); }
  }
  async begin(operation, toolCallId) {
    const id = randomUUID();
    const record = { version: 1, id, session: this.session, operation, toolCallId: toolCallId ?? null, ownerPid: process.pid, ownerLock: 1, state: 'pending', requests: [] };
    this.active.add(id);
    let db;
    try { await this.holdOwner(id); db = await this.database(); }
    catch (error) {
      this.active.delete(id);
      await this.releaseOwner(id);
      await this.removeOwnerFile(id);
      throw error;
    }
    try {
      db.exec('BEGIN IMMEDIATE');
      const { count } = db.prepare('SELECT (SELECT COUNT(*) FROM requests WHERE session = ?) + (SELECT COUNT(*) FROM cleanup WHERE session = ?) AS count').get(this.session, this.session);
      if (count >= this.limit) throw new Error('Recovery journal is full; deliver and acknowledge saved results before submitting more requests');
      db.prepare('INSERT INTO requests (id, session, data) VALUES (?, ?, ?)').run(id, this.session, JSON.stringify(record));
      db.exec('COMMIT');
      this.created.add(id);
      return id;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* The transaction may not have started. */ }
      this.active.delete(id);
      await this.releaseOwner(id);
      await this.removeOwnerFile(id);
      throw error;
    } finally { db.close(); }
  }
  async update(id, change) {
    if (!validId(id)) throw new Error('Invalid recovery request ID');
    const db = await this.database();
    try {
      db.exec('BEGIN IMMEDIATE');
      const row = db.prepare('SELECT data FROM requests WHERE id = ? AND session = ?').get(id, this.session);
      if (!row) throw new Error('Recovery request is unavailable');
      const value = JSON.parse(row.data);
      db.prepare('UPDATE requests SET data = ? WHERE id = ? AND session = ?').run(JSON.stringify(change(value)), id, this.session);
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* Transaction did not start. */ } throw error; }
    finally { db.close(); }
  }
  async addRequest(id, request) { await this.update(id, value => ({ ...value, requests: [...value.requests, request] })); }
  async preserveReceipt(id, requestId) {
    await this.update(id, value => ({ ...value, requests: value.requests.map(request => request.id === requestId ? { ...request, refused: true } : request) }));
  }
  async complete(id, result) { await this.update(id, value => ({ ...value, state: 'result', result })); this.active.delete(id); await this.releaseOwner(id); }
  async fail(id, error) {
    try { await this.update(id, value => value.state === 'result' ? value : ({ ...value, state: error.effect === 'not-applied' ? 'error' : 'unknown', error })); }
    finally { this.active.delete(id); await this.releaseOwner(id); }
  }
  async snapshot(resolveReceipts, includeAcknowledged = false, selectedIds) {
    const db = await this.database();
    let rows, acknowledgements;
    try {
      rows = db.prepare('SELECT id, data FROM requests WHERE session = ?').all(this.session);
      acknowledgements = new Set(db.prepare('SELECT a.id, a.revision FROM acknowledgements a JOIN requests r ON r.id = a.id WHERE r.session = ?').all(this.session).map(row => `${row.id}:${row.revision}`));
    } finally { db.close(); }
    const values = [];
    for (const row of rows) {
      if (selectedIds && !selectedIds.has(row.id)) continue;
      const value = JSON.parse(row.data);
      if (value.version !== 1 || value.session !== this.session || value.id !== row.id) throw new Error('Invalid recovery journal entry');
      let state = value.state === 'pending' && !this.active.has(value.id) && !this.ownerAlive(value) ? 'unknown' : value.state;
      const evidence = state === 'unknown' && resolveReceipts && value.requests.length ? await resolveReceipts(value.requests) : undefined;
      const direct = evidence?.length === 1 && value.requests[0]?.wire?.do === value.operation && evidence[0].state === 'done' && !evidence[0].result?.error && evidence[0].result?.outcome !== 'unknown';
      if (state === 'unknown' && direct) state = 'result';
      const result = direct ? evidence[0].result : value.result;
      const event = { id: value.id, session: value.session, operation: value.operation, toolCallId: value.toolCallId, state,
        ...(result !== undefined ? { result } : {}), ...(value.error && !direct ? { error: value.error } : {}), ...(evidence ? { evidence } : {}) };
      const revision = digest(JSON.stringify(event));
      const recoverable = state !== 'pending' && !this.active.has(value.id);
      const final = state !== 'unknown' || value.requests.length === 0 || (evidence?.length === value.requests.length && evidence.every(item => item.state === 'done'));
      if (includeAcknowledged || !acknowledgements.has(`${value.id}:${revision}`)) values.push({ event: { ...event, revision, recoverable }, data: row.data, requests: value.requests, final });
    }
    return values;
  }
  async list(resolveReceipts) { return (await this.snapshot(resolveReceipts)).map(row => row.event); }
  async cleanupPending() {
    const db = await this.database();
    try { return db.prepare('SELECT id, receipt FROM cleanup WHERE session = ?').all(this.session); }
    finally { db.close(); }
  }
  async cleanupComplete(id) {
    const db = await this.database();
    try { db.prepare('DELETE FROM cleanup WHERE id = ? AND session = ?').run(id, this.session); }
    finally { db.close(); }
  }
  async ack({ items }, resolveReceipts) {
    if (!Array.isArray(items) || items.some(item => !validId(item?.id) || !/^[0-9a-f]{64}$/.test(item?.revision))) throw new Error('Invalid recovery acknowledgement');
    const current = new Map((await this.snapshot(resolveReceipts, true, new Set(items.map(item => item.id)))).map(row => [row.event.id, row]));
    const db = await this.database(), reclaimed = [], finished = [];
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const { id, revision } of items) {
        const row = current.get(id), event = row?.event;
        if (!row) continue;
        if (event?.revision === revision && event.state === 'pending') throw new Error('Cannot acknowledge an active request');
        // An old revision never acknowledges a later event. Keep unknown receipts for late results.
        db.prepare('INSERT OR IGNORE INTO acknowledgements (id, revision) VALUES (?, ?)').run(id, revision);
        if (event && event.state !== 'pending' && row.final && event.revision === revision && !this.active.has(id)) {
          const deleted = db.prepare('DELETE FROM requests WHERE id = ? AND session = ? AND data = ?').run(id, this.session, row.data);
          if (deleted.changes) {
            finished.push(id);
            db.prepare('DELETE FROM acknowledgements WHERE id = ?').run(id);
            for (const request of row.requests) {
              if (request.refused) continue;
              db.prepare('INSERT OR IGNORE INTO cleanup (id, session, receipt) VALUES (?, ?, ?)').run(request.id, this.session, request.receipt);
              reclaimed.push(request);
            }
          }
        }
      }
      db.exec('COMMIT');
      for (const id of finished) {
        this.created.delete(id);
        await this.removeOwnerFile(id);
      }
      return reclaimed;
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* Transaction did not start. */ } throw error; }
    finally { db.close(); }
  }
}
