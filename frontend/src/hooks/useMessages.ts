import { useEffect, useState } from 'react';
import { ChatMessage, PendingLedger } from '../types';

interface UseMessagesResult {
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  pendingLedger: PendingLedger | null;
  setPendingLedger: React.Dispatch<React.SetStateAction<PendingLedger | null>>;
}

export function useMessages(
  apiUrl: string,
  sessionId: string
): UseMessagesResult {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'system', content: '歡迎使用 Temporal AI Chat。' },
  ]);
  const [pendingLedger, setPendingLedger] = useState<PendingLedger | null>(null);

  useEffect(() => {
    async function loadMessagesForSession() {
      if (!sessionId) return;
      try {
        const res = await fetch(`${apiUrl}/api/sessions/${sessionId}/messages`);
        const json = await res.json();
        const items = (json?.items ?? []) as {
          role: 'user' | 'assistant' | 'system';
          content: string;
        }[];

        let lastLedger: PendingLedger | null = null;
        let lastLedgerIdx = -1;

        const mapped: ChatMessage[] = items.map((m, idx) => {
          if (m.role === 'assistant') {
            try {
              const parsed = JSON.parse(String(m.content));
              if (parsed?.__kind === 'ledger_proposal' && parsed?.proposal) {
                const explain = String(parsed.explain ?? '請確認記帳');
                lastLedger = { explain, proposal: parsed.proposal };
                lastLedgerIdx = idx;
                return { role: 'assistant', content: explain };
              }
            } catch {}
          }
          return { role: m.role, content: m.content };
        });

        setMessages(
          mapped.length > 0
            ? mapped
            : [{ role: 'system', content: '新會話，開始聊天吧。' }]
        );

        // 僅當最後一則訊息是 ledger_proposal 時才帶出待確認卡片
        if (lastLedger && lastLedgerIdx === items.length - 1) {
          setPendingLedger(lastLedger);
        } else {
          setPendingLedger(null);
        }
      } catch (e) {
        setMessages([{ role: 'system', content: '載入歷史失敗。' }]);
      }
    }
    loadMessagesForSession();
  }, [apiUrl, sessionId]);

  return { messages, setMessages, pendingLedger, setPendingLedger };
}

