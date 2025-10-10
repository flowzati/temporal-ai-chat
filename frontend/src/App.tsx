import React, { useEffect, useMemo, useRef, useState } from 'react';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface SessionItem {
  session_id: string;
  title: string | null;
  updated_at_ms: number;
}

function makeWs(url: string): WebSocket {
  return new WebSocket(url);
}

export function App() {
  // WebSocket 位置可透過 .env 設定，預設 ws://localhost:4000/ws
  const wsUrl = import.meta.env.VITE_WS_URL ?? 'ws://localhost:4000/ws';
  const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [sessionId, setSessionId] = useState(() => Math.random().toString(36).slice(2)); // 預設新 session
  const [userId] = useState('demo-user');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'system', content: '歡迎使用 Temporal AI Chat。' },
  ]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
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

  // 載入 sessions 列表
  useEffect(() => {
    async function loadSessions() {
      try {
        const res = await fetch(`${apiUrl}/api/sessions`);
        const json = await res.json();
        const items = (json?.items ?? []) as SessionItem[];
        setSessions(items);
      } catch (e) {
        // ignore
      }
    }
    loadSessions();
    const t = setInterval(loadSessions, 5000);
    return () => clearInterval(t);
  }, [apiUrl]);

  // 切換 session 時載入歷史
  useEffect(() => {
    async function loadMessagesForSession() {
      if (!sessionId) return;
      try {
        const res = await fetch(`${apiUrl}/api/sessions/${sessionId}/messages`);
        const json = await res.json();
        const items = (json?.items ?? []) as { role: 'user' | 'assistant' | 'system'; content: string }[];
        const mapped: ChatMessage[] = items.map((m) => ({ role: m.role, content: m.content }));
        setMessages(mapped.length > 0 ? mapped : [{ role: 'system', content: '新會話，開始聊天吧。' }]);
      } catch (e) {
        setMessages([{ role: 'system', content: '載入歷史失敗。' }]);
      }
    }
    loadMessagesForSession();
  }, [apiUrl, sessionId]);

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
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'Inter, system-ui, sans-serif' }}>
      {/* Sidebar */}
      <div style={{ width: 280, borderRight: '1px solid #eee', padding: 12, overflow: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Sessions</h2>
          <button
            onClick={() => {
              setSessionId(Math.random().toString(36).slice(2));
              setMessages([{ role: 'system', content: '新會話，開始聊天吧。' }]);
            }}
          >
            新建
          </button>
        </div>
        <div style={{ fontSize: 12, marginTop: 6, color: connected ? 'green' : 'red' }}>
          {connected ? '已連線' : '未連線'}
        </div>
        <div style={{ marginTop: 12 }}>
          {sessions.map((s) => (
            <div
              key={s.session_id}
              onClick={() => setSessionId(s.session_id)}
              style={{
                padding: 8,
                borderRadius: 6,
                cursor: 'pointer',
                background: s.session_id === sessionId ? '#eef2ff' : 'transparent',
                border: '1px solid #e5e7eb',
                marginBottom: 8,
              }}
              title={s.session_id}
            >
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {s.title || '（未命名）'}
              </div>
              <div style={{ fontSize: 12, color: '#374151', wordBreak: 'break-all' }}>
                {s.session_id}
              </div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                {new Date(s.updated_at_ms).toLocaleString()}
              </div>
            </div>
          ))}
          {sessions.length === 0 && (
            <div style={{ color: '#6b7280', fontSize: 14 }}>尚無會話</div>
          )}
        </div>
      </div>

      {/* Main chat */}
      <div style={{ flex: 1, maxWidth: 900, margin: '0 auto', padding: 24 }}>
        <h1 style={{ marginTop: 0 }}>Temporal AI Chat</h1>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, minHeight: 300, background: '#fafafa' }}>
          {messages.map((m, idx) => (
            <div key={idx} style={{ marginBottom: 8 }}>
              <strong>{m.role}: </strong>
              <span>{m.content}</span>
            </div>
          ))}
        </div>
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
    </div>
  );
}
