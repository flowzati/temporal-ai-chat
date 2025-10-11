import React, { useRef, useState } from 'react';

interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
  disabled: boolean;
  waitingReply: boolean;
  canSend: boolean;
}

export function MessageInput({
  value,
  onChange,
  onSend,
  onCancel,
  disabled,
  waitingReply,
  canSend,
}: MessageInputProps) {
  const composingRef = useRef(false);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const nativeAny = e.nativeEvent as any;
    const isComposing =
      nativeAny?.isComposing === true ||
      composingRef.current ||
      nativeAny?.keyCode === 229;
    if (e.key === 'Enter') {
      if (isComposing) return;
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
      <input
        style={{
          flex: 1,
          padding: 8,
          border: '1px solid #ddd',
          borderRadius: 6,
        }}
        placeholder="輸入訊息..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onKeyDown={handleKeyDown}
      />
      <button
        onClick={waitingReply ? onCancel : onSend}
        disabled={waitingReply ? disabled : !canSend}
        title={waitingReply ? '取消當前處理' : '送出訊息'}
      >
        {waitingReply ? '取消' : '送出'}
      </button>
    </div>
  );
}

