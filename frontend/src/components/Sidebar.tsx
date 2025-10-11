import React from 'react';
import { SessionItem } from '../types';

interface SidebarProps {
  open: boolean;
  connected: boolean;
  sessions: SessionItem[];
  currentSessionId: string;
  onToggle: () => void;
  onSessionSelect: (sessionId: string) => void;
  onNewSession: () => void;
}

export function Sidebar({
  open,
  connected,
  sessions,
  currentSessionId,
  onToggle,
  onSessionSelect,
  onNewSession,
}: SidebarProps) {
  return (
    <>
      <div
        style={{
          width: open ? 280 : 0,
          borderRight: '1px solid #eee',
          padding: open ? 12 : 0,
          overflow: open ? 'auto' : 'hidden',
          transition: 'width 0.2s ease, padding 0.2s ease',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16 }}>Sessions</h2>
          <button onClick={onNewSession}>新建</button>
        </div>
        <div
          style={{
            fontSize: 12,
            marginTop: 6,
            color: connected ? 'green' : 'red',
          }}
        >
          {connected ? '已連線' : '未連線'}
        </div>
        <div style={{ marginTop: 12 }}>
          {sessions.map((s) => (
            <SessionCard
              key={s.session_id}
              session={s}
              isActive={s.session_id === currentSessionId}
              onClick={() => onSessionSelect(s.session_id)}
            />
          ))}
          {sessions.length === 0 && (
            <div style={{ color: '#6b7280', fontSize: 14 }}>尚無會話</div>
          )}
        </div>
      </div>
      <button
        onClick={onToggle}
        aria-expanded={open}
        title={open ? '收起側邊欄' : '打開側邊欄'}
      >
        ☰
      </button>
    </>
  );
}

interface SessionCardProps {
  session: SessionItem;
  isActive: boolean;
  onClick: () => void;
}

function SessionCard({ session, isActive, onClick }: SessionCardProps) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: 8,
        borderRadius: 6,
        cursor: 'pointer',
        background: isActive ? '#eef2ff' : 'transparent',
        border: '1px solid #e5e7eb',
        marginBottom: 8,
      }}
      title={session.session_id}
    >
      <div style={{ fontWeight: 600, fontSize: 14 }}>
        {session.title || '（未命名）'}
      </div>
      <div
        style={{ fontSize: 12, color: '#374151', wordBreak: 'break-all' }}
      >
        {session.session_id}
      </div>
      <div style={{ fontSize: 12, color: '#6b7280' }}>
        {new Date(session.updated_at_ms).toLocaleString()}
      </div>
    </div>
  );
}

