import { useEffect, useMemo, useState } from 'react';
import { ChatMessage, PendingLedger } from '../types';
import { sendWebSocketMessage } from '../utils/websocket';

/**
 * 生成请求唯一标识（用于幂等性）
 */
function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

interface UseChatParams {
  wsRef: React.RefObject<WebSocket | null>;
  sessionId: string;
  userId: string;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setPendingLedger: React.Dispatch<React.SetStateAction<PendingLedger | null>>;
  setSessionId?: React.Dispatch<React.SetStateAction<string | null>>;
}

export function useChat({
  wsRef,
  sessionId,
  userId,
  setMessages,
  setPendingLedger,
  setSessionId,
}: UseChatParams) {
  const [input, setInput] = useState('');
  const [waitingReply, setWaitingReply] = useState(false);

  // 設置 WebSocket 消息處理
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;

    const handleMessage = (evt: MessageEvent) => {
      try {
        const data = JSON.parse(String(evt.data));
        if (data?.type === 'assistant_message') {
          setWaitingReply(false);
          
          // 如果是新 session，更新 sessionId
          if (data.isNewSession && data.sessionId && setSessionId) {
            console.log(`New session created: ${data.sessionId}`);
            setSessionId(data.sessionId);
          }
          
          // 嘗試解析是否為 ledger_proposal
          try {
            const parsed = JSON.parse(String(data.message));
            if (parsed?.__kind === 'ledger_proposal' && parsed?.proposal) {
              setPendingLedger({
                explain: String(parsed.explain ?? ''),
                proposal: parsed.proposal,
              });
              setMessages((prev) => [
                ...prev,
                {
                  role: 'assistant',
                  content: parsed.explain ?? '請確認記帳',
                },
              ]);
              return;
            }
          } catch {}
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: data.message },
          ]);
        } else if (data?.type === 'error') {
          setWaitingReply(false);
          setMessages((prev) => [
            ...prev,
            { role: 'system', content: `錯誤：${data.error}` },
          ]);
        } else if (
          data?.type === 'assistant_message' &&
          typeof data.message === 'string' &&
          data.message.includes('已取消')
        ) {
          setWaitingReply(false);
        }
      } catch (e) {
        setWaitingReply(false);
        setMessages((prev) => [
          ...prev,
          { role: 'system', content: '伺服器回傳格式錯誤' },
        ]);
      }
    };

    ws.addEventListener('message', handleMessage);
    return () => {
      ws.removeEventListener('message', handleMessage);
    };
  }, [wsRef, setMessages, setPendingLedger, setSessionId]);

  const canSend = useMemo(
    () => input.trim().length > 0 && !waitingReply,
    [input, waitingReply]
  );

  const sendMessage = () => {
    if (!wsRef.current || !canSend) return;
    sendWebSocketMessage(wsRef.current, {
      type: 'user_message',
      sessionId,
      userId,
      message: input.trim(),
      requestId: generateRequestId(), // 幂等性：添加请求ID
    });
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: input.trim() },
    ]);
    setInput('');
    setWaitingReply(true);
  };

  const cancelAll = () => {
    if (!wsRef.current || !waitingReply) return;
    sendWebSocketMessage(wsRef.current, {
      type: 'cancel',
      sessionId,
      userId,
      requestId: generateRequestId(), // 幂等性：添加请求ID
    });
  };

  return {
    input,
    setInput,
    waitingReply,
    canSend,
    sendMessage,
    cancelAll,
  };
}

