import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../..', '.env') });

// 加載並驗證後端所需的環境變數
// - PORT：伺服器監聽埠
// - TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE / TEMPORAL_TASK_QUEUE：Temporal 叢集連線
// - TEMPORAL_SESSION_IDLE_TIMEOUT：session 閒置多久後由 server sweeper 關閉 workflow
// - TEMPORAL_SESSION_IDLE_SWEEP_INTERVAL：server 多久掃描一次閒置 session
// - OPENAI_API_KEY：OpenAI 金鑰（activities 會使用）
// - SQLITE_DB_PATH：SQLite 檔案路徑（相對路徑以 repo root 為基準，預設 ./backend/chat.db）
export type AppConfig = {
  port: number; // 伺服器監聽的埠號
  temporalAddress: string; // Temporal 叢集位址 (host:port)
  temporalNamespace: string; // Temporal 命名空間
  temporalTaskQueue: string; // Temporal Task Queue
  temporalSessionIdleTimeoutMs: number; // Session 閒置 timeout（毫秒）
  temporalSessionIdleSweepIntervalMs: number; // 閒置 session 掃描間隔（毫秒）
  openaiApiKey: string; // OpenAI API 金鑰
  dbPath: string; // SQLite DB 路徑
};

export function loadConfig(): AppConfig {
  const portStr = process.env.PORT ?? '4000';
  const temporalAddress = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
  const temporalNamespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const temporalTaskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'chat-ai';
  const temporalSessionIdleTimeout = process.env.TEMPORAL_SESSION_IDLE_TIMEOUT ?? '30m';
  const temporalSessionIdleSweepInterval = process.env.TEMPORAL_SESSION_IDLE_SWEEP_INTERVAL ?? '1m';
  const openaiApiKey = process.env.OPENAI_API_KEY ?? '';
  const dbPathRaw = process.env.SQLITE_DB_PATH ?? './backend/chat.db';
  const dbPath = path.isAbsolute(dbPathRaw)
    ? dbPathRaw
    : path.resolve(__dirname, '../../..', dbPathRaw);

  // 缺少金鑰直接拋錯，避免在執行時期才發生問題
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required');
  }

  const port = Number(portStr);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${portStr}`);
  }

  const temporalSessionIdleTimeoutMs = parseDurationMs(temporalSessionIdleTimeout, 'TEMPORAL_SESSION_IDLE_TIMEOUT');
  const temporalSessionIdleSweepIntervalMs = parseDurationMs(temporalSessionIdleSweepInterval, 'TEMPORAL_SESSION_IDLE_SWEEP_INTERVAL');

  return {
    port,
    temporalAddress,
    temporalNamespace,
    temporalTaskQueue,
    temporalSessionIdleTimeoutMs,
    temporalSessionIdleSweepIntervalMs,
    openaiApiKey,
    dbPath,
  };
}

function parseDurationMs(value: string, name: string): number {
  const match = value.trim().match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  const amount = Number(match[1]);
  const unit = match[2] ?? 'ms';
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return amount * multipliers[unit];
}
