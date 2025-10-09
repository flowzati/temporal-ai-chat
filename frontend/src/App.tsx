import React, { useEffect, useMemo, useRef, useState } from 'react';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

function makeWs(url: string): WebSocket {
  return new WebSocket(url);
}

export function App() {
  // WebSocket 位置可透過 .env 設定，預設 ws://localhost:4000/ws
  const wsUrl = import.meta.env.VITE_WS_URL ?? 'ws://localhost:4000/ws';
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [sessionId] = useState(() => Math.random().toString(36).slice(2)); // 簡單產生 session id
  const [userId] = useState('demo-user');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'system', content: '歡迎使用 Temporal AI Chat。' },
  ]);
  // 中文輸入法組字狀態（避免組字時 Enter 觸發送出）
  const composingRef = useRef(false);

  // 建立 WebSocket 並處理連線狀態/訊息
  useEffect(() => {
    const ws = makeWs(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(String(evt.data));
        if (data?.type === 'assistant_message') {
          setMessages((prev) => [...prev, { role: 'assistant', content: data.message }]);
        } else if (data?.type === 'error') {
          setMessages((prev) => [...prev, { role: 'system', content: `錯誤：${data.error}` }]);
        }
      } catch (e) {
        setMessages((prev) => [...prev, { role: 'system', content: '伺服器回傳格式錯誤' }]);
      }
    };

    return () => {
      ws.close();
    };
  }, [wsUrl]);

  // 僅在連線且輸入不為空時允許送出
  const canSend = useMemo(() => connected && input.trim().length > 0, [connected, input]);

  // 送出使用者訊息給後端，後端會啟動工作流處理
  function sendMessage() {
    if (!wsRef.current || !canSend) return;
    const payload = {
      type: 'user_message',
      sessionId,
      userId,
      message: input.trim(),
    };
    wsRef.current.send(JSON.stringify(payload));
    setMessages((prev) => [...prev, { role: 'user', content: input.trim() }]);
    setInput('');
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: 24, fontFamily: 'Inter, system-ui, sans-serif' }}>
      <h1 style={{ marginTop: 0 }}>Temporal AI Chat</h1>
      <div style={{ marginBottom: 12, color: connected ? 'green' : 'red' }}>
        {connected ? '已連線' : '未連線'}
      </div>

      {/* 簡單的訊息列表 */}
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, minHeight: 300, background: '#fafafa' }}>
        {messages.map((m, idx) => (
          <div key={idx} style={{ marginBottom: 8 }}>
            <strong>{m.role}: </strong>
            <span>{m.content}</span>
          </div>
        ))}
      </div>

      {/* 輸入框 + 送出按鈕 */}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          style={{ flex: 1, padding: 8, border: '1px solid #ddd', borderRadius: 6 }}
          placeholder="輸入訊息..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={(e) => {
            // 在組字中（中文輸入法）時，Enter 只用於確認組字，不應觸發送出
            const nativeAny = e.nativeEvent as any;
            const isComposing = nativeAny?.isComposing === true || composingRef.current || nativeAny?.keyCode === 229;
            if (e.key === 'Enter') {
              if (isComposing) return;
              e.preventDefault();
              sendMessage();
            }
          }}
        />
        <button onClick={sendMessage} disabled={!canSend}>
          送出
        </button>
      </div>
    </div>
  );
}
