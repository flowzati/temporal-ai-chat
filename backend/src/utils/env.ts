import dotenv from 'dotenv';

dotenv.config();

// 加載並驗證後端所需的環境變數
// - PORT：伺服器監聽埠
// - TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE：Temporal 叢集連線
// - OPENAI_API_KEY：OpenAI 金鑰（activities 會使用）
// - SQLITE_DB_PATH：SQLite 檔案路徑（預設 ./chat.db）
export type AppConfig = {
  port: number; // 伺服器監聽的埠號
  temporalAddress: string; // Temporal 叢集位址 (host:port)
  temporalNamespace: string; // Temporal 命名空間
  openaiApiKey: string; // OpenAI API 金鑰
  dbPath: string; // SQLite DB 路徑
};

export function loadConfig(): AppConfig {
  const portStr = process.env.PORT ?? '4000';
  const temporalAddress = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
  const temporalNamespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const openaiApiKey = process.env.OPENAI_API_KEY ?? '';
  const dbPath = process.env.SQLITE_DB_PATH ?? './chat.db';

  // 缺少金鑰直接拋錯，避免在執行時期才發生問題
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required');
  }

  const port = Number(portStr);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${portStr}`);
  }

  return {
    port,
    temporalAddress,
    temporalNamespace,
    openaiApiKey,
    dbPath,
  };
}
