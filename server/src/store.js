import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ENV } from "./config.js";

mkdirSync(ENV.dataDir, { recursive: true });
const db = new DatabaseSync(join(ENV.dataDir, "faucet.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 3000;
  CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL,
    ip TEXT NOT NULL,
    asset TEXT NOT NULL,
    symbol TEXT NOT NULL,
    amount TEXT NOT NULL,
    tx_hash TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS claims_address_idx ON claims (address, created_at);
  CREATE INDEX IF NOT EXISTS claims_ip_idx ON claims (ip, created_at);
  CREATE INDEX IF NOT EXISTS claims_created_idx ON claims (created_at);
  CREATE TABLE IF NOT EXISTS used_tokens (
    token TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
`);

const COUNTED = "status IN ('pending', 'sent')";

const statements = {
  byAddress: db.prepare(`SELECT COUNT(*) AS n, MAX(created_at) AS last FROM claims WHERE address = ? AND created_at >= ? AND ${COUNTED}`),
  byIp: db.prepare(`SELECT COUNT(*) AS n, MAX(created_at) AS last FROM claims WHERE ip = ? AND created_at >= ? AND ${COUNTED}`),
  global: db.prepare(`SELECT COUNT(*) AS n FROM claims WHERE created_at >= ? AND ${COUNTED}`),
  insert: db.prepare(
    `INSERT INTO claims (address, ip, asset, symbol, amount, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  ),
  finish: db.prepare(`UPDATE claims SET status = ?, tx_hash = ?, error = ? WHERE id = ?`),
  recent: db.prepare(
    `SELECT address, symbol, amount, tx_hash, created_at FROM claims WHERE status = 'sent' ORDER BY id DESC LIMIT ?`
  ),
  admin: db.prepare(`SELECT * FROM claims ORDER BY id DESC LIMIT ?`),
  totals: db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last24h,
            COUNT(DISTINCT address) AS addresses
       FROM claims WHERE status = 'sent'`
  ),
  useToken: db.prepare(`INSERT OR IGNORE INTO used_tokens (token, expires_at) VALUES (?, ?)`),
  pruneTokens: db.prepare(`DELETE FROM used_tokens WHERE expires_at < ?`),
};

export function claimCounts({ address, ip, since }) {
  const a = statements.byAddress.get(address, since);
  const i = statements.byIp.get(ip, since);
  return {
    address: Number(a.n),
    addressLast: a.last == null ? 0 : Number(a.last),
    ip: Number(i.n),
    ipLast: i.last == null ? 0 : Number(i.last),
  };
}

export const globalCount = (since) => Number(statements.global.get(since).n);

export function reserveClaim({ address, ip, asset, symbol, amount }) {
  return Number(statements.insert.run(address, ip, asset, symbol, amount, Date.now()).lastInsertRowid);
}

export function finishClaim(id, { status, txHash = null, error = null }) {
  statements.finish.run(status, txHash, error ? String(error).slice(0, 300) : null, id);
}

export function recentClaims(limit = 10) {
  return statements.recent.all(limit).map((row) => ({
    address: `${row.address.slice(0, 6)}…${row.address.slice(-4)}`,
    symbol: row.symbol,
    amount: row.amount,
    txHash: row.tx_hash,
    at: Number(row.created_at),
  }));
}

export function adminClaims(limit = 100) {
  return statements.admin.all(Math.min(500, Math.max(1, limit))).map((row) => ({
    id: Number(row.id),
    address: row.address,
    ip: row.ip,
    asset: row.asset,
    symbol: row.symbol,
    amount: row.amount,
    txHash: row.tx_hash,
    status: row.status,
    error: row.error,
    at: Number(row.created_at),
  }));
}

export function claimTotals() {
  const row = statements.totals.get(Date.now() - 24 * 3600_000);
  return { total: Number(row.total || 0), last24h: Number(row.last24h || 0), addresses: Number(row.addresses || 0) };
}

/** Records a single-use token (PoW salt or admin signature); false when it was already used. */
export function consumeToken(token, expiresAt) {
  statements.pruneTokens.run(Date.now());
  return statements.useToken.run(token, expiresAt).changes > 0;
}
