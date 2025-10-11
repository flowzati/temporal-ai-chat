import React from 'react';
import { PendingLedger } from '../types';

interface LedgerConfirmCardProps {
  pendingLedger: PendingLedger;
  onConfirm: () => void;
  onCancel: () => void;
}

export function LedgerConfirmCard({
  pendingLedger,
  onConfirm,
  onCancel,
}: LedgerConfirmCardProps) {
  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        border: '1px dashed #cbd5e1',
        borderRadius: 8,
        background: '#f8fafc',
      }}
    >
      <div style={{ marginBottom: 8 }}>
        {pendingLedger.explain || '請確認記帳'}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={onConfirm}
          style={{
            background: '#16a34a',
            color: '#fff',
            border: 'none',
            padding: '6px 12px',
            borderRadius: 6,
          }}
        >
          確認記帳
        </button>
        <button
          onClick={onCancel}
          style={{
            background: '#ef4444',
            color: '#fff',
            border: 'none',
            padding: '6px 12px',
            borderRadius: 6,
          }}
        >
          取消
        </button>
      </div>
    </div>
  );
}

