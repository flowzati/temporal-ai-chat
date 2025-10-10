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
  const [waitingReply, setWaitingReply] = useState(false);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const messagesBoxRef = useRef<HTMLDivElement | null>(null);
  const [pendingLedger, setPendingLedger] = useState<null | {
    explain: string;
    proposal: { title: string; amountCents: number; occurredAtMs: number };
  }>(null);
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
          setWaitingReply(false);
          // 嘗試解析是否為 ledger_proposal
          try {
            const parsed = JSON.parse(String(data.message));
            if (parsed?.__kind === 'ledger_proposal' && parsed?.proposal) {
              setPendingLedger({ explain: String(parsed.explain ?? ''), proposal: parsed.proposal });
              setMessages((prev) => [...prev, { role: 'assistant', content: parsed.explain ?? '請確認記帳' }]);
              return;
            }
          } catch {}
          setMessages((prev) => [...prev, { role: 'assistant', content: data.message }]);
        } else if (data?.type === 'error') {
          setWaitingReply(false);
          setMessages((prev) => [...prev, { role: 'system', content: `錯誤：${data.error}` }]);
        } else if (data?.type === 'assistant_message' && typeof data.message === 'string' && data.message.includes('已取消')) {
          // 保險：若後端取消訊息路由不同步，此處也確保解鎖按鈕
          setWaitingReply(false);
        }
      } catch (e) {
        setWaitingReply(false);
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

  // 新訊息時自動捲到底部
  useEffect(() => {
    const el = messagesBoxRef.current;
    if (!el) return;
    // 使用 smooth 體驗更佳；大量訊息時也可切成 auto
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // 僅在連線且輸入不為空時允許送出
  const canSend = useMemo(() => connected && input.trim().length > 0 && !waitingReply, [connected, input, waitingReply]);

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
    setWaitingReply(true);
  }

  function cancelAll() {
    if (!wsRef.current || !waitingReply) return;
    const payload = {
      type: 'cancel',
      sessionId,
      userId,
    };
    wsRef.current.send(JSON.stringify(payload));
  }

  function confirmLedger() {
    if (!wsRef.current || !pendingLedger) return;
    const payload = {
      type: 'confirm_ledger',
      sessionId,
      userId,
      proposal: pendingLedger.proposal,
    };
    wsRef.current.send(JSON.stringify(payload));
    setPendingLedger(null);
  }

  function cancelLedger() {
    setPendingLedger(null);
    setMessages((prev) => [...prev, { role: 'system', content: '已取消記帳' }]);
  }

  return (
    <div style={{ display: 'flex', height: '98vh', fontFamily: 'Inter, system-ui, sans-serif' }}>
      {/* Sidebar */}
      <div style={{ width: sidebarOpen ? 280 : 0, borderRight: '1px solid #eee', padding: sidebarOpen ? 12 : 0, overflow: sidebarOpen ? 'auto' : 'hidden', transition: 'width 0.2s ease, padding 0.2s ease' }}>
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
      <button onClick={() => setSidebarOpen((v) => !v)} aria-expanded={sidebarOpen} title={sidebarOpen ? '收起側邊欄' : '打開側邊欄'}>
        ☰
      </button>

      {/* Main chat */}
      <div style={{ flex: 1, maxWidth: 900, margin: '0 auto', padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h1 style={{ marginTop: 0 }}>OpenAI Agents & Temporal</h1>
          </div>
        </div>
        <div ref={messagesBoxRef} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, height: '80vh', overflowY: 'auto', background: '#fafafa' }}>
          {messages.map((m, idx) => {
            const isUser = m.role === 'user';
            const isAssistant = m.role === 'assistant';
            const isSystem = m.role === 'system';
            if (isSystem) {
              return (
                <div key={idx} style={{ marginBottom: 8, textAlign: 'center', color: '#6b7280', fontSize: 12 }}>
                  {m.content}
                </div>
              );
            }
            return (
              <div key={idx} style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', marginBottom: 8 }}>
                <div
                  style={{
                    background: isUser ? '#dcfce7' : '#ffffff',
                    color: '#111827',
                    border: '1px solid #e5e7eb',
                    padding: '8px 10px',
                    borderRadius: 12,
                    maxWidth: '75%',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {m.content}
                </div>
              </div>
            );
          })}

          {pendingLedger && (
            <div style={{ marginTop: 12, padding: 12, border: '1px dashed #cbd5e1', borderRadius: 8, background: '#f8fafc' }}>
              <div style={{ marginBottom: 8 }}>{pendingLedger.explain || '請確認記帳'}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={confirmLedger} style={{ background: '#16a34a', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6 }}>確認記帳</button>
                <button onClick={cancelLedger} style={{ background: '#ef4444', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6 }}>取消</button>
              </div>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input
            style={{ flex: 1, padding: 8, border: '1px solid #ddd', borderRadius: 6 }}
            placeholder="輸入訊息..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!connected || waitingReply}
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
          <button onClick={sendMessage} disabled={!canSend} title={waitingReply ? '等待回覆中' : '送出訊息'}>
            送出
          </button>
          <button onClick={cancelAll} disabled={!connected || !waitingReply} title={waitingReply ? '取消當前處理' : '等待回覆時才可取消'}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
