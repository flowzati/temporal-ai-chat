import React, { useState } from 'react';
import { useWebSocket, useSessions, useMessages, useLedger } from './hooks';
import { useChat } from './hooks/useChat';
import { Sidebar, ChatMessages, MessageInput } from './components';

export function App() {
  // 環境配置
  const wsUrl = import.meta.env.VITE_WS_URL ?? 'ws://localhost:4000/ws';
  const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

  // 狀態管理
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [userId] = useState('demo-user');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // 自定義 hooks
  const { wsRef, connected } = useWebSocket(wsUrl);
  const sessions = useSessions(apiUrl);
  const { messages, setMessages, pendingLedger, setPendingLedger } =
    useMessages(apiUrl, sessionId);

  const { input, setInput, waitingReply, canSend, sendMessage, cancelAll } =
    useChat({
      wsRef,
      sessionId: sessionId || 'new',
      userId,
      setMessages,
      setPendingLedger,
      setSessionId,
    });

  const { confirmLedger, cancelLedger } = useLedger({
    wsRef,
    sessionId: sessionId || 'new',
    userId,
    pendingLedger,
    setPendingLedger,
    setMessages,
  });

  // 事件處理
  const handleNewSession = () => {
    setSessionId(null);
    setMessages([{ role: 'system', content: '新會話，開始聊天吧。' }]);
  };

  const handleSessionSelect = (id: string) => {
    setSessionId(id);
  };

  return (
    <div
      style={{
        display: 'flex',
        height: '98vh',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <Sidebar
        open={sidebarOpen}
        connected={connected}
        sessions={sessions}
        currentSessionId={sessionId || ''}
        onToggle={() => setSidebarOpen((v) => !v)}
        onSessionSelect={handleSessionSelect}
        onNewSession={handleNewSession}
      />

      <div
        style={{
          flex: 1,
          maxWidth: 900,
          margin: '0 auto',
          padding: 24,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h1 style={{ marginTop: 0 }}>OpenAI Agents & Temporal</h1>
          </div>
        </div>

        <ChatMessages
          messages={messages}
          pendingLedger={pendingLedger}
          onConfirmLedger={confirmLedger}
          onCancelLedger={cancelLedger}
        />

        <MessageInput
          value={input}
          onChange={setInput}
          onSend={sendMessage}
          onCancel={cancelAll}
          disabled={!connected || waitingReply}
          waitingReply={waitingReply}
          canSend={canSend}
        />
      </div>
    </div>
  );
}
