import { PendingLedger } from '../types';

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

