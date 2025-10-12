import React, { useEffect, useRef } from 'react';
import { ChatMessage as ChatMessageType } from '../types';
import { ChatMessage } from './ChatMessage';
import { LoadingIndicator } from './LoadingIndicator';

interface ChatMessagesProps {
  messages: ChatMessageType[];
  waitingReply: boolean;
}

export function ChatMessages({
  messages,
  waitingReply,
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
    </div>
  );
}

