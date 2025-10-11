import React, { useEffect, useRef } from 'react';
import { ChatMessage as ChatMessageType, PendingLedger } from '../types';
import { ChatMessage } from './ChatMessage';
import { LedgerConfirmCard } from './LedgerConfirmCard';

interface ChatMessagesProps {
  messages: ChatMessageType[];
  pendingLedger: PendingLedger | null;
  onConfirmLedger: () => void;
  onCancelLedger: () => void;
}

export function ChatMessages({
  messages,
  pendingLedger,
  onConfirmLedger,
  onCancelLedger,
}: ChatMessagesProps) {
  const messagesBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = messagesBoxRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  return (
    <div
      ref={messagesBoxRef}
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        padding: 12,
        height: '80vh',
        overflowY: 'auto',
        background: '#fafafa',
      }}
    >
      {messages.map((m, idx) => (
        <ChatMessage key={idx} message={m} />
      ))}

      {pendingLedger && (
        <LedgerConfirmCard
          pendingLedger={pendingLedger}
          onConfirm={onConfirmLedger}
          onCancel={onCancelLedger}
        />
      )}
    </div>
  );
}

