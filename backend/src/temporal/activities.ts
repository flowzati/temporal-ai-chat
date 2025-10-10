import { insertLedgerEntry } from '../utils/db';
import { ParsedLedgerProposalFlat, Capability, SendMessageArgs, LedgerProposal } from '../types';
import * as ai from '../services/ai';

// Removed ChatReplyArgs; use plain string parameters

// activities 僅作為輕薄代理，重邏輯在 services/ai.ts

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

export async function parseLedgerProposal(args: SendMessageArgs): Promise<ParsedLedgerProposalFlat> {
  try {
    return await ai.parseLedgerProposal(args);
  } catch (err: any) {
    throw new Error(`parseLedgerProposal failed: ${err?.message ?? 'unknown error'}`);
  }
}

export async function queryLedgerRange(args: SendMessageArgs): Promise<string> {
  try {
    return await ai.queryLedgerRange(args);
  } catch (err: any) {
    throw new Error(`queryLedgerRange failed: ${err?.message ?? 'unknown error'}`);
  }
}

export async function saveLedger(proposal: LedgerProposal): Promise<string> {
  try {
    insertLedgerEntry({
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
