export interface UserMessagePayload {
  type: 'user_message';
  sessionId: string;
  userId: string;
  message: string;
}

export interface CancelPayload {
  type: 'cancel';
  sessionId: string;
  userId: string;
}

export interface ConfirmLedgerPayload {
  type: 'confirm_ledger';
  sessionId: string;
  userId: string;
  proposal: {
    title: string;
    amountCents: number;
    occurredAtMs: number;
  };
}

export type WebSocketPayload = UserMessagePayload | CancelPayload | ConfirmLedgerPayload;

export function sendWebSocketMessage(ws: WebSocket | null, payload: WebSocketPayload) {
  if (!ws) return;
  ws.send(JSON.stringify(payload));
}

