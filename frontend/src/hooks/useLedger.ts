import { PendingLedger } from '../types';

/**
 * 生成请求唯一标识（用于幂等性）
 */
function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

interface UseLedgerParams {
  wsRef: React.RefObject<WebSocket | null>;
  sessionId: string;
  userId: string;
  pendingLedger: PendingLedger | null;
  setPendingLedger: React.Dispatch<React.SetStateAction<PendingLedger | null>>;
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
}

export function useLedger({
  wsRef,
  sessionId,
  userId,
  pendingLedger,
  setPendingLedger,
  setMessages,
}: UseLedgerParams) {
  const confirmLedger = () => {
    if (!wsRef.current || !pendingLedger) return;
    const payload = {
      type: 'confirm_ledger',
      sessionId,
      userId,
      proposal: pendingLedger.proposal,
      requestId: generateRequestId(), // 幂等性：添加请求ID
    };
    wsRef.current.send(JSON.stringify(payload));
    setPendingLedger(null);
  };

  const cancelLedger = () => {
    setPendingLedger(null);
    setMessages((prev) => [
      ...prev,
      { role: 'system', content: '已取消記帳' },
    ]);
  };

  return { confirmLedger, cancelLedger };
}

