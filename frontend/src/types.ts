export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface SessionItem {
  session_id: string;
  title: string | null;
  updated_at_ms: number;
}

export interface LedgerProposal {
  title: string;
  amountCents: number;
  occurredAtMs: number;
}

export interface PendingLedger {
  explain: string;
  proposal: LedgerProposal;
}

