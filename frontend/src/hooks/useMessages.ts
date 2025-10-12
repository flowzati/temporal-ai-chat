import { useEffect, useState } from 'react';
import { ChatMessage } from '../types';

interface UseMessagesResult {
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

export function useMessages(
  apiUrl: string,
  sessionId: string | null
): UseMessagesResult {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'system', content: '歡迎使用 Temporal AI Chat。' },
  ]);

  useEffect(() => {
    async function loadMessagesForSession() {
      // 如果沒有 sessionId 或是新 session，不載入
      if (!sessionId || sessionId === 'new') {
        setMessages([{ role: 'system', content: '新會話，開始聊天吧。' }]);
        return;
      }
      
      try {
        const res = await fetch(`${apiUrl}/api/sessions/${sessionId}/messages`);
        const json = await res.json();
        const items = (json?.items ?? []) as {
          role: 'user' | 'assistant' | 'system';
          content: string;
        }[];

        const mapped: ChatMessage[] = items.map((m) => ({
          role: m.role,
          content: m.content
        }));

        setMessages(
          mapped.length > 0
            ? mapped
            : [{ role: 'system', content: '新會話，開始聊天吧。' }]
        );
      } catch (e) {
        setMessages([{ role: 'system', content: '載入歷史失敗。' }]);
      }
    }
    loadMessagesForSession();
  }, [apiUrl, sessionId]);

  return { messages, setMessages };
}

