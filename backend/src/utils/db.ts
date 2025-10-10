import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { loadConfig } from './env';

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


