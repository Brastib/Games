'use strict';
/**
 * Einfacher Datenspeicher:
 *  - Alles liegt im Arbeitsspeicher (schnell).
 *  - Änderungen werden verzögert gesichert:
 *      * MongoDB, wenn MONGODB_URI gesetzt ist (nötig bei Render & Co., weil dort die Festplatte gelöscht wird)
 *      * sonst JSON-Dateien im Ordner DATA_DIR (Standard: ./data)
 */
const fs = require('fs');
const path = require('path');

const WRITE_DELAY = 1500;

class JsonDriver {
  constructor(dir) {
    this.dir = dir;
    this.timers = new Map();
  }
  async init() {
    fs.mkdirSync(this.dir, { recursive: true });
  }
  async loadAll() {
    const out = {};
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue;
      const name = file.slice(0, -5);
      try {
        out[name] = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8'));
      } catch (e) {
        console.error(`[store] Datei ${file} ist beschädigt und wird ignoriert:`, e.message);
      }
    }
    return out;
  }
  schedule(col, getSnapshot) {
    if (this.timers.has(col)) return;
    this.timers.set(col, setTimeout(() => {
      this.timers.delete(col);
      this.writeNow(col, getSnapshot());
    }, WRITE_DELAY));
  }
  writeNow(col, obj) {
    const file = path.join(this.dir, `${col}.json`);
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error(`[store] Konnte ${col} nicht speichern:`, e.message);
    }
  }
}

class MongoDriver {
  constructor(uri, dbName) {
    this.uri = uri;
    this.dbName = dbName;
    this.pending = new Map(); // "col\0key" -> {col, key, value|undefined}
    this.timer = null;
  }
  async init() {
    const { MongoClient } = require('mongodb');
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 15000 });
    await this.client.connect();
    this.db = this.client.db(this.dbName);
  }
  async loadAll() {
    const out = {};
    const cols = await this.db.listCollections({}, { nameOnly: true }).toArray();
    for (const { name } of cols) {
      out[name] = {};
      const docs = await this.db.collection(name).find({}).toArray();
      for (const d of docs) {
        try { out[name][d._id] = JSON.parse(d.j); } catch { /* defekter Eintrag */ }
      }
    }
    return out;
  }
  queue(col, key, value) {
    this.pending.set(col + '\0' + key, { col, key, value });
    if (!this.timer) this.timer = setTimeout(() => this.flush(), WRITE_DELAY);
  }
  async flush() {
    this.timer = null;
    const items = [...this.pending.values()];
    this.pending.clear();
    const byCol = new Map();
    for (const it of items) {
      if (!byCol.has(it.col)) byCol.set(it.col, []);
      byCol.get(it.col).push(
        it.value === undefined
          ? { deleteOne: { filter: { _id: it.key } } }
          : { replaceOne: { filter: { _id: it.key }, replacement: { _id: it.key, j: JSON.stringify(it.value) }, upsert: true } },
      );
    }
    for (const [col, ops] of byCol) {
      try {
        await this.db.collection(col).bulkWrite(ops, { ordered: false });
      } catch (e) {
        console.error(`[store] MongoDB-Fehler in ${col}:`, e.message);
      }
    }
  }
}

class Store {
  constructor() {
    this.cols = new Map();
    this.driver = null;
    this.kind = 'memory';
  }

  async init() {
    const uri = process.env.MONGODB_URI;
    if (uri) {
      this.driver = new MongoDriver(uri, process.env.MONGODB_DB || 'discordbot');
      this.kind = 'mongodb';
    } else {
      this.driver = new JsonDriver(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
      this.kind = 'json';
    }
    await this.driver.init();
    const all = await this.driver.loadAll();
    for (const [name, obj] of Object.entries(all)) {
      this.cols.set(name, new Map(Object.entries(obj)));
    }
    console.log(`[store] Speicher bereit (${this.kind}), ${this.cols.size} Sammlungen geladen.`);
  }

  col(name) {
    if (!this.cols.has(name)) this.cols.set(name, new Map());
    return this.cols.get(name);
  }
  get(col, key) { return this.col(col).get(key); }
  has(col, key) { return this.col(col).has(key); }
  set(col, key, value) {
    this.col(col).set(key, value);
    this.persist(col, key, value);
    return value;
  }
  /** Nach direktem Ändern eines Objekts aufrufen, damit es gespeichert wird. */
  touch(col, key) {
    const v = this.col(col).get(key);
    if (v !== undefined) this.persist(col, key, v);
  }
  delete(col, key) {
    const had = this.col(col).delete(key);
    if (had) this.persist(col, key, undefined);
    return had;
  }
  entries(col) { return [...this.col(col).entries()]; }
  values(col) { return [...this.col(col).values()]; }

  persist(col, key, value) {
    if (!this.driver) return;
    if (this.driver instanceof MongoDriver) this.driver.queue(col, key, value);
    else this.driver.schedule(col, () => Object.fromEntries(this.col(col)));
  }

  async flush() {
    if (!this.driver) return;
    if (this.driver instanceof MongoDriver) {
      if (this.driver.timer) clearTimeout(this.driver.timer);
      await this.driver.flush();
    } else {
      for (const [col, t] of this.driver.timers) {
        clearTimeout(t);
        this.driver.writeNow(col, Object.fromEntries(this.col(col)));
      }
      this.driver.timers.clear();
    }
  }
}

module.exports = new Store();
