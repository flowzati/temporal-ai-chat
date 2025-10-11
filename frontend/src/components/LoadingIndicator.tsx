import React from 'react';

export function LoadingIndicator() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 16px',
        marginBottom: 8,
        background: '#f3f4f6',
        borderRadius: 12,
        maxWidth: 'fit-content',
      }}
    >
      <div style={{ display: 'flex', gap: 4 }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: '#6b7280',
            animation: 'bounce 1.4s infinite ease-in-out both',
            animationDelay: '-0.32s',
          }}
        />
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: '#6b7280',
            animation: 'bounce 1.4s infinite ease-in-out both',
            animationDelay: '-0.16s',
          }}
        />
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: '#6b7280',
            animation: 'bounce 1.4s infinite ease-in-out both',
          }}
        />
      </div>
      <span style={{ fontSize: 14, color: '#6b7280' }}>AI 正在思考...</span>
      <style>
        {`
          @keyframes bounce {
            0%, 80%, 100% {
              transform: scale(0);
              opacity: 0.5;
            }
            40% {
              transform: scale(1);
              opacity: 1;
            }
          }
        `}
      </style>
    </div>
  );
}

