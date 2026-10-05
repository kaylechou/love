/* D1 兼容层：把 Cloudflare D1 API 翻译成 Node 内置 node:sqlite，供 NAS/Docker 本地运行 */
import { DatabaseSync } from 'node:sqlite';

class D1PreparedStatement {
  constructor(db, sql) {
    this._db = db;
    this._sql = sql;
    this._params = [];
  }
  bind(...params) {
    this._params = (params.length === 1 && Array.isArray(params[0])) ? params[0] : params;
    return this;
  }
  async all() {
    const stmt = this._db.prepare(this._sql);
    const results = stmt.all(...this._params);
    return { results, success: true };
  }
  async first() {
    const stmt = this._db.prepare(this._sql);
    const row = stmt.get(...this._params);
    return row === undefined ? null : row;
  }
  async run() {
    const stmt = this._db.prepare(this._sql);
    const info = stmt.run(...this._params);
    return {
      success: true,
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
        rows_read: 0,
        rows_written: Number(info.changes),
      },
    };
  }
}

export class D1Shim {
  constructor(dbPath) {
    this._db = new DatabaseSync(dbPath);
    this._db.exec('PRAGMA journal_mode = WAL;');
    this._db.exec('PRAGMA synchronous = NORMAL;');
  }
  prepare(sql) {
    return new D1PreparedStatement(this._db, sql);
  }
  async batch(statements) {
    // D1 batch 语义：顺序执行，整体视为一个事务
    this._db.exec('BEGIN;');
    try {
      const out = [];
      for (const s of statements) {
        const stmt = this._db.prepare(s._sql);
        if (/^\s*SELECT/i.test(s._sql)) {
          out.push({ results: stmt.all(...s._params), success: true });
        } else {
          const info = stmt.run(...s._params);
          out.push({ success: true, meta: { changes: Number(info.changes) } });
        }
      }
      this._db.exec('COMMIT;');
      return out;
    } catch (e) {
      try { this._db.exec('ROLLBACK;'); } catch (_) {}
      throw e;
    }
  }
  async exec(sql) {
    this._db.exec(sql);
    return { success: true };
  }
  close() {
    this._db.close();
  }
}
