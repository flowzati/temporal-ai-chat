import { Trigger } from '@temporalio/workflow';

export interface ChatBase {
  userId: string;
  sessionId: string | undefined | null;
}

export interface UserMessage extends ChatBase {
  userMessage: string;
}

export interface SendMessageArgs extends UserMessage {
  startedAtMs: number;
}

export interface StartSessionArgs {
  sessionId: string;
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

export interface ParsedLedgerProposalFlat extends ChatBase {
  title: string;
  amountCents: number;
  occurredAtMs: number;
  explain: string;
}

export type Capability = 'chat' | 'weather' | 'ledger_proposal' | 'ledger_query';
