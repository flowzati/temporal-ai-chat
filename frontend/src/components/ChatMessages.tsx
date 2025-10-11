import React, { useEffect, useRef } from 'react';
import { ChatMessage as ChatMessageType, PendingLedger } from '../types';
import { ChatMessage } from './ChatMessage';
import { LedgerConfirmCard } from './LedgerConfirmCard';
import { LoadingIndicator } from './LoadingIndicator';

interface ChatMessagesProps {
  messages: ChatMessageType[];
  pendingLedger: PendingLedger | null;
  waitingReply: boolean;
  onConfirmLedger: () => void;
  onCancelLedger: () => void;
}

export function ChatMessages({
  messages,
  pendingLedger,
  waitingReply,
  onConfirmLedger,
  onCancelLedger,
}: ChatMessagesProps) {
  const messagesBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = messagesBoxRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, waitingReply]);

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

      {waitingReply && <LoadingIndicator />}

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

