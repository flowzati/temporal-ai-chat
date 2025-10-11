import { ParsedLedgerProposalResult, Capability, SendMessageArgs, SaveLedgerInput, LedgerQueryRangeResult, LedgerEntryRow, InitializeSessionArgs, SaveMessageArgs } from '../types';
import * as ledger from '../utils/ledger';
import * as db from '../utils/db';
import * as ai from '../utils/ai';

// 決策可用功能：聊天、查天氣、記帳、查帳
export async function decideCapability(text: string): Promise<Capability> {
  try {
    return await ai.decideCapability(text);
  } catch (err: any) {
    throw new Error(`decideCapability failed: ${err?.message ?? 'unknown error'}`);
  }
}

// 使用 @openai/agents 產生回覆（在 worker 執行）
export async function chatReply(userMessage: string): Promise<string> {
  try {
    return await ai.chatReply(userMessage);
  } catch (err: any) {
    throw new Error(`chatReply failed: ${err?.message ?? 'unknown error'}`);
  }
}

// 使用工具的 Agent（加入天氣查詢）
export async function weatherReply(userMessage: string): Promise<string> {
  try {
    return await ai.weatherReply(userMessage);
  } catch (err: any) {
    throw new Error(`weatherReply failed: ${err?.message ?? 'unknown error'}`);
  }
}

export async function parseLedgerProposal(args: SendMessageArgs): Promise<ParsedLedgerProposalResult> {
  try {
    return await ai.parseLedgerProposal(args.text, args.userId, args.sessionId);
  } catch (err: any) {
    throw new Error(`parseLedgerProposal failed: ${err?.message ?? 'unknown error'}`);
  }
}

export async function queryLedgerRange(args: SendMessageArgs): Promise<string> {
  try {
    const range: LedgerQueryRangeResult = await ai.queryLedgerRange(args.text);
    const entries: LedgerEntryRow[] = db.listLedgerEntriesByRange(args.userId, range.startMs, range.endMs);
    return ledger.formatLedgerSummary(entries, new Date(range.startMs), new Date(range.endMs));
  } catch (err: any) {
    throw new Error(`queryLedgerRange failed: ${err?.message ?? 'unknown error'}`);
  }
}

export async function saveLedger(proposal: SaveLedgerInput): Promise<string> {
  try {
    db.insertLedgerEntry({
      userId: proposal.userId,
      sessionId: proposal.sessionId ?? null,
      title: proposal.title,
      amountCents: proposal.amountCents,
      occurredAtMs: proposal.occurredAtMs,
      createdAtMs: Date.now(),
    });
    return '已存入記帳';
  } catch (err: any) {
    throw new Error(`saveLedger failed: ${err?.message ?? 'unknown error'}`);
  }
}

/**
 * 保存訊息到 DB
 */
export async function saveMessage(params: SaveMessageArgs): Promise<void> {
  try {
    db.insertMessage(params.sessionId, params.role, params.content, params.timestamp);
  } catch (err: any) {
    throw new Error(`saveMessage failed: ${err?.message ?? 'unknown error'}`);
  }
}

/**
 * 初始化 session（僅在首次使用時調用）
 */
export async function initializeSession(params: InitializeSessionArgs): Promise<void> {
  try {
    db.upsertSession(params.sessionId, params.title, params.timestamp);
  } catch (err: any) {
    throw new Error(`initializeSession failed: ${err?.message ?? 'unknown error'}`);
  }
}
