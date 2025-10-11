import { Trigger } from '@temporalio/workflow';

export interface StartSessionParams {
  sessionId: string;
  startedAtMs: number;
  processedRequestIds?: string[]; // 幂等性：从 ContinueAsNew 传递的已处理 requestId
}
export interface ChatBase {
  userId: string;
  sessionId: string;
}

export interface SendMessageParams extends ChatBase {
  text: string;
  startedAtMs: number;
  requestId?: string; // 幂等性：请求唯一标识
}

export interface QueueItem extends SendMessageParams {
  completion: Trigger<string>;
}

export interface ConfirmLedgerArgs extends ChatBase {
  proposal: { title: string; amountCents: number; occurredAtMs: number };
  requestId?: string; // 幂等性：请求唯一标识
}

export interface SaveLedgerInput extends ChatBase {
  title: string;
  amountCents: number;
  occurredAtMs: number;
  requestId?: string; // 幂等性：请求唯一标识
}

export interface ParsedLedgerProposalResult extends ChatBase {
  title: string;
  amountCents: number;
  occurredAtMs: number;
  explain: string;
}

export interface LedgerQueryRangeResult {
  startMs: number;
  endMs: number;
}

export type Capability = 'chat' | 'weather' | 'ledger_proposal' | 'ledger_query';

export interface LedgerRangeInput {
  range: 'today' | 'yesterday' | 'date' | 'month' | 'week';
  date?: string; // YYYY-MM-DD for date/month/week when specified
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

export interface SaveMessageArgs {
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  messageId?: string; // 幂等性：消息唯一标识
}

export interface InitializeSessionArgs {
  sessionId: string;
  title: string | null;
  timestamp: number;
}

// 幂等性缓存条目
export interface IdempotencyRecord {
  requestId: string;
  result: string;
  timestamp: number;
}