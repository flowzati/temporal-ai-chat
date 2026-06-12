import { ParsedLedgerProposalResult, Capability, SendMessageParams, SaveLedgerInput, LedgerQueryRangeResult, LedgerEntryRow, InitializeSessionArgs, SaveMessageArgs } from '../types';
import * as db from '../utils/db';
import * as ai from '../utils/ai';

// 決策可用功能：聊天、查天氣、記帳、查帳 (@openai/agents)
export async function decideCapability(text: string): Promise<Capability> {
  try {
    return await ai.decideCapability(text);
  } catch (err: any) {
    throw new Error(`decideCapability failed: ${err?.message ?? 'unknown error'}`);
  }
}

// 產生回覆 (@openai/agents)
export async function chatReply(text: string): Promise<string> {
  try {
    return await ai.chatReply(text);
  } catch (err: any) {
    throw new Error(`chatReply failed: ${err?.message ?? 'unknown error'}`);
  }
}

// 使用工具的 Agent（加入天氣查詢） (@openai/agents)
export async function weatherReply(text: string): Promise<string> {
  try {
    return await ai.weatherReply(text);
  } catch (err: any) {
    throw new Error(`weatherReply failed: ${err?.message ?? 'unknown error'}`);
  }
}

// 解析記帳 (@openai/agents)
export async function parseLedgerProposal(params: SendMessageParams): Promise<ParsedLedgerProposalResult> {
  try {
    return await ai.parseLedgerProposal(params.text, params.userId, params.sessionId);
  } catch (err: any) {
    throw new Error(`parseLedgerProposal failed: ${err?.message ?? 'unknown error'}`);
  }
}

//解析記帳查詢範圍（@openai/agents）
export async function parseLedgerQuery(text: string): Promise<LedgerQueryRangeResult> {
  try {
    return await ai.queryLedgerRange(text);
  } catch (err: any) {
    throw new Error(`parseLedgerQuery failed: ${err?.message ?? 'unknown error'}`);
  }
}

// 取得記帳項目（DB 查詢）
export async function getLedgerEntries(params: {
  userId: string;
  startMs: number;
  endMs: number;
}): Promise<LedgerEntryRow[]> {
  try {
    return db.listLedgerEntriesByRange(params.userId, params.startMs, params.endMs);
  } catch (err: any) {
    throw new Error(`getLedgerEntries failed: ${err?.message ?? 'unknown error'}`);
  }
}

// 儲存記帳項目（DB 操作）
export async function saveLedger(proposal: SaveLedgerInput): Promise<string> {
  try {
    // 幂等性：使用 requestId 作为 ledgerId
    db.insertLedgerEntry({
      userId: proposal.userId,
      sessionId: proposal.sessionId ?? null,
      title: proposal.title,
      amountCents: proposal.amountCents,
      occurredAtMs: proposal.occurredAtMs,
      createdAtMs: Date.now(),
      ledgerId: `ledger-${proposal.requestId}`
    });
    return '已存入記帳';
  } catch (err: any) {
    throw new Error(`saveLedger failed: ${err?.message ?? 'unknown error'}`);
  }
}

// 儲存訊息到 DB（支持幂等性）
export async function saveMessage(params: SaveMessageArgs): Promise<void> {
  try {
    db.insertMessage(
      params.sessionId, 
      params.role, 
      params.content, 
      params.timestamp,
      params.messageId // 幂等性ID
    );
  } catch (err: any) {
    throw new Error(`saveMessage failed: ${err?.message ?? 'unknown error'}`);
  }
}

// 對話初始化 session
export async function initializeSession(params: InitializeSessionArgs): Promise<void> {
  try {
    db.upsertSession(params.sessionId, params.title, params.timestamp);
  } catch (err: any) {
    throw new Error(`initializeSession failed: ${err?.message ?? 'unknown error'}`);
  }
}

// 撤銷最近一筆記帳
export async function undoLastLedger(params: SendMessageParams): Promise<string> {
  try {
    // 取得最近一筆記帳
    const lastEntry = db.getLastLedgerEntry(params.userId, params.sessionId);
    
    if (!lastEntry) {
      return '沒有可以撤銷的記帳記錄';
    }
    
    // 刪除該記帳
    const deleted = db.deleteLedgerEntry(lastEntry.id);
    
    if (!deleted) {
      throw new Error('刪除記帳失敗');
    }
    
    // 格式化金額顯示
    const amountDisplay = lastEntry.amount_cents >= 0 
      ? `+${(lastEntry.amount_cents / 100).toFixed(2)}`
      : `${(lastEntry.amount_cents / 100).toFixed(2)}`;
    
    return `已撤銷記帳：${lastEntry.title} ${amountDisplay} 元`;
  } catch (err: any) {
    throw new Error(`undoLastLedger failed: ${err?.message ?? 'unknown error'}`);
  }
}
