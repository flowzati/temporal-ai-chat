export interface UserMessagePayload {
  type: 'user_message';
  sessionId: string;
  userId: string;
  message: string;
  requestId?: string; // 幂等性：请求唯一标识
}

export interface CancelPayload {
  type: 'cancel';
  sessionId: string;
  userId: string;
  requestId?: string; // 幂等性：请求唯一标识
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
  requestId?: string; // 幂等性：请求唯一标识
}

export type WebSocketPayload = UserMessagePayload | CancelPayload | ConfirmLedgerPayload;

export function sendWebSocketMessage(ws: WebSocket | null, payload: WebSocketPayload) {
  if (!ws) return;
  ws.send(JSON.stringify(payload));
}

