import { Trigger } from '@temporalio/workflow';
import { z } from 'zod';

export interface StartSessionArgs {
  sessionId: string;
  startedAtMs: number;
}
export interface ChatBase {
  userId: string;
  sessionId: string;
}

export interface UserMessage extends ChatBase {
  text: string;
}

export interface SendMessageArgs extends UserMessage {
  startedAtMs: number;
}

export interface QueueItem extends SendMessageArgs {
  completion: Trigger<string>;
}

export interface ConfirmLedgerArgs extends ChatBase {
  proposal: { title: string; amountCents: number; occurredAtMs: number };
}

export interface SaveLedgerInput extends ChatBase {
  title: string;
  amountCents: number;
  occurredAtMs: number;
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
}

export interface InitializeSessionArgs {
  sessionId: string;
  title: string | null;
  timestamp: number;
}