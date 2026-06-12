import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { loadConfig } from './env';
import { LedgerEntryRow } from '../types';
// 說明：集中管理 SQLite 連線與遷移；提供 sessions/messages/ledger 的基本操作

export type Db = Database.Database;

export interface SessionRow {
  session_id: string;
  title: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  closed_at_ms: number | null;
}

export interface MessageRow {
  id: number;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at_ms: number;
  message_id?: string | null; // 幂等性：消息唯一标识
}

export interface IdleSessionRow {
  session_id: string;
  updated_at_ms: number;
  closed_at_ms: number | null;
}

let dbInstance: Db | null = null;

export function getDb(): Db {
  if (dbInstance) return dbInstance;
  const { dbPath } = loadConfig();
  const abs = path.resolve(dbPath);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(abs);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  dbInstance = db;
  return db;
}

function migrate(db: Db) {
  // Schema：
  // - sessions：會話清單（以 session_id 為主鍵）
  // - messages：聊天訊息（依 session 排序，支持幂等性）
  // - ledger_entries：記帳明細（user 維度聚合，時間範圍查詢，支持幂等性）
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      title TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      message_id TEXT, 
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at_ms);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id) WHERE message_id IS NOT NULL;
    
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      session_id TEXT,
      title TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      occurred_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      ledger_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user_occurred ON ledger_entries(user_id, occurred_at_ms);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_ledger_id ON ledger_entries(ledger_id) WHERE ledger_id IS NOT NULL;
  `);
  ensureColumn(db, 'sessions', 'closed_at_ms', 'closed_at_ms INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_open_updated ON sessions(closed_at_ms, updated_at_ms)');
}

function ensureColumn(db: Db, tableName: string, columnName: string, columnDefinition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
  }
}

export function upsertSession(sessionId: string, title: string | null, nowMs: number): void {
  const db = getDb();
  const existing = db.prepare('SELECT session_id FROM sessions WHERE session_id = ?').get(sessionId) as { session_id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE sessions SET title = COALESCE(?, title), updated_at_ms = ?, closed_at_ms = NULL WHERE session_id = ?').run(title, nowMs, sessionId);
  } else {
    db.prepare('INSERT INTO sessions (session_id, title, created_at_ms, updated_at_ms, closed_at_ms) VALUES (?, ?, ?, ?, NULL)')
      .run(sessionId, title, nowMs, nowMs);
  }
}

export function insertMessage(
  sessionId: string, 
  role: 'user' | 'assistant' | 'system', 
  content: string, 
  createdAtMs: number,
  messageId?: string | null
): void {
  const db = getDb();

  upsertSession(sessionId, null, createdAtMs);
  
  // 幂等性检查：如果 messageId 存在且已有记录，则跳过插入
  if (messageId) {
    const existing = db.prepare('SELECT id FROM messages WHERE message_id = ?').get(messageId);
    if (existing) {
      console.log(`[insertMessage] Message already exists: ${messageId}`);
      return;
    }
  }
  
  db.prepare('INSERT INTO messages (session_id, role, content, created_at_ms, message_id) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, role, content, createdAtMs, messageId ?? null);
  db.prepare('UPDATE sessions SET updated_at_ms = ? WHERE session_id = ?').run(createdAtMs, sessionId);
}

export function listSessions(limit = 50): SessionRow[] {
  const db = getDb();
  return db.prepare('SELECT session_id, title, created_at_ms, updated_at_ms, closed_at_ms FROM sessions ORDER BY updated_at_ms DESC LIMIT ?')
    .all(limit) as SessionRow[];
}

export function listIdleOpenSessions(cutoffMs: number, limit = 100): IdleSessionRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT session_id, updated_at_ms, closed_at_ms FROM sessions WHERE closed_at_ms IS NULL AND updated_at_ms <= ? ORDER BY updated_at_ms ASC LIMIT ?'
  ).all(cutoffMs, limit) as IdleSessionRow[];
}

export function markSessionClosed(sessionId: string, closedAtMs: number, cutoffMs: number): boolean {
  const db = getDb();
  const result = db.prepare(
    'UPDATE sessions SET closed_at_ms = ? WHERE session_id = ? AND closed_at_ms IS NULL AND updated_at_ms <= ?'
  ).run(closedAtMs, sessionId, cutoffMs);
  return result.changes > 0;
}

export function getMessages(sessionId: string, limit = 500): MessageRow[] {
  const db = getDb();
  return db.prepare('SELECT id, session_id, role, content, created_at_ms FROM messages WHERE session_id = ? ORDER BY created_at_ms ASC LIMIT ?')
    .all(sessionId, limit) as MessageRow[];
}

export function sessionExists(sessionId: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(sessionId) as { 1?: number } | undefined;
  return !!row;
}


export function insertLedgerEntry(params: {
  userId: string;
  sessionId?: string | null;
  title: string;
  amountCents: number;
  occurredAtMs: number;
  createdAtMs: number;
  ledgerId?: string | null; // 幂等性：记账唯一标识
}): void {
  const db = getDb();
  
  // 幂等性检查：如果 ledgerId 存在且已有记录，则跳过插入
  if (params.ledgerId) {
    const existing = db.prepare('SELECT id FROM ledger_entries WHERE ledger_id = ?').get(params.ledgerId);
    if (existing) {
      console.log(`[insertLedgerEntry] Ledger entry already exists: ${params.ledgerId}`);
      return;
    }
  }
  
  db.prepare(
    'INSERT INTO ledger_entries (user_id, session_id, title, amount_cents, occurred_at_ms, created_at_ms, ledger_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    params.userId, 
    params.sessionId ?? null, 
    params.title, 
    params.amountCents, 
    params.occurredAtMs, 
    params.createdAtMs,
    params.ledgerId ?? null
  );
}

// Note: retaining listLedgerEntriesByRange for potential future detailed listings
export function listLedgerEntriesByRange(userId: string, startMs: number, endMs: number): LedgerEntryRow[] {
  const db = getDb();
  return db
    .prepare(
      'SELECT id, user_id, session_id, title, amount_cents, occurred_at_ms, created_at_ms FROM ledger_entries WHERE user_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ? ORDER BY occurred_at_ms ASC'
    )
    .all(userId, startMs, endMs) as LedgerEntryRow[];
}

export function sumLedgerEntriesByRange(userId: string, startMs: number, endMs: number): number {
  const db = getDb();
  const row = db
    .prepare('SELECT COALESCE(SUM(amount_cents), 0) as total FROM ledger_entries WHERE user_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?')
    .get(userId, startMs, endMs) as { total: number };
  return row?.total ?? 0;
}

export function getLastLedgerEntry(userId: string, sessionId?: string): LedgerEntryRow | null {
  const db = getDb();
  const query = sessionId
    ? 'SELECT id, user_id, session_id, title, amount_cents, occurred_at_ms, created_at_ms FROM ledger_entries WHERE user_id = ? AND session_id = ? ORDER BY created_at_ms DESC LIMIT 1'
    : 'SELECT id, user_id, session_id, title, amount_cents, occurred_at_ms, created_at_ms FROM ledger_entries WHERE user_id = ? ORDER BY created_at_ms DESC LIMIT 1';
  
  const params = sessionId ? [userId, sessionId] : [userId];
  return (db.prepare(query).get(...params) as LedgerEntryRow | undefined) ?? null;
}

export function deleteLedgerEntry(entryId: number): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(entryId);
  return result.changes > 0;
}
