import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { loadConfig } from './env';
// 說明：集中管理 SQLite 連線與遷移；提供 sessions/messages/ledger 的基本操作

export type Db = Database.Database;

export interface SessionRow {
  session_id: string;
  title: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface MessageRow {
  id: number;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at_ms: number;
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
  // - messages：聊天訊息（依 session 排序）
  // - ledger_entries：記帳明細（user 維度聚合，時間範圍查詢）
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      title TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at_ms);
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      session_id TEXT,
      title TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      occurred_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user_occurred ON ledger_entries(user_id, occurred_at_ms);
  `);
}

export function upsertSession(sessionId: string, title: string | null, nowMs: number): void {
  const db = getDb();
  const existing = db.prepare('SELECT session_id FROM sessions WHERE session_id = ?').get(sessionId) as { session_id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE sessions SET title = COALESCE(?, title), updated_at_ms = ? WHERE session_id = ?').run(title, nowMs, sessionId);
  } else {
    db.prepare('INSERT INTO sessions (session_id, title, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)')
      .run(sessionId, title, nowMs, nowMs);
  }
}

export function insertMessage(sessionId: string, role: 'user' | 'assistant' | 'system', content: string, createdAtMs: number): void {
  const db = getDb();
  db.prepare('INSERT INTO messages (session_id, role, content, created_at_ms) VALUES (?, ?, ?, ?)')
    .run(sessionId, role, content, createdAtMs);
  db.prepare('UPDATE sessions SET updated_at_ms = ? WHERE session_id = ?').run(createdAtMs, sessionId);
}

export function listSessions(limit = 50): SessionRow[] {
  const db = getDb();
  return db.prepare('SELECT session_id, title, created_at_ms, updated_at_ms FROM sessions ORDER BY updated_at_ms DESC LIMIT ?')
    .all(limit) as SessionRow[];
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

// Ledger helpers
export interface LedgerEntryRow {
  id: number;
  user_id: string;
  session_id: string | null;
  title: string;
  amount_cents: number; // 正為加項，負為減項
  occurred_at_ms: number;
  created_at_ms: number;
}

export function insertLedgerEntry(params: {
  userId: string;
  sessionId?: string | null;
  title: string;
  amountCents: number;
  occurredAtMs: number;
  createdAtMs: number;
}): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO ledger_entries (user_id, session_id, title, amount_cents, occurred_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(params.userId, params.sessionId ?? null, params.title, params.amountCents, params.occurredAtMs, params.createdAtMs);
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


