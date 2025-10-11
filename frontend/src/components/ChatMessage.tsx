import React from 'react';
import { ChatMessage as ChatMessageType } from '../types';

interface ChatMessageProps {
  message: ChatMessageType;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  const isSystem = message.role === 'system';

  if (isSystem) {
    return (
      <div
        style={{
          marginBottom: 8,
          textAlign: 'center',
          color: '#6b7280',
          fontSize: 12,
        }}
      >
        {message.content}
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: 8,
      }}
    >
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
        {message.content}
      </div>
    </div>
  );
}

