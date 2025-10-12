import { LedgerRangeInput, LedgerEntryRow } from '../types';

function startOfDay(date: Date): Date {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

function addDays(date: Date, numDays: number): Date {
  return new Date(date.getTime() + numDays * 24 * 60 * 60 * 1000);
}

function startOfMonth(date: Date): Date {
  const normalized = new Date(date);
  normalized.setDate(1);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

function addMonths(date: Date, numMonths: number): Date {
  const updated = new Date(date);
  updated.setMonth(updated.getMonth() + numMonths);
  return updated;
}

function startOfWeekMonday(date: Date): Date {
  const normalized = startOfDay(date);
  const dayOfWeek = normalized.getDay(); // 0 (Sun) .. 6 (Sat)
  const diffFromMonday = (dayOfWeek + 6) % 7; // Monday = 0
  return addDays(normalized, -diffFromMonday);
}

export function computeLedgerRange(input: LedgerRangeInput, baseDate: Date): { start: Date; end: Date } {
  const base = new Date(baseDate);
  base.setHours(0, 0, 0, 0);

  const { range, date } = input;
  if (range === 'today') {
    const start = startOfDay(base);
    const end = addDays(start, 1);
    return { start, end };
  }
  if (range === 'yesterday') {
    const end = startOfDay(base);
    const start = addDays(end, -1);
    return { start, end };
  }
  if (range === 'date') {
    const day = new Date(date as string);
    if (isNaN(day.getTime())) throw new Error('Invalid date');
    const start = startOfDay(day);
    const end = addDays(start, 1);
    return { start, end };
  }
  if (range === 'week') {
    const baseForWeek = date ? new Date(date) : base;
    const weekStart = startOfWeekMonday(baseForWeek);
    const start = weekStart;
    const end = addDays(weekStart, 7);
    return { start, end };
  }
  if (range === 'month') {
    const baseForMonth = date ? new Date(`${date}-01`) : base;
    const start = startOfMonth(baseForMonth);
    const end = addMonths(start, 1);
    return { start, end };
  }
  throw new Error('Unsupported range');
}

export function formatLedgerSummary(entries: LedgerEntryRow[], start: Date, end: Date): string {
  let incomeCents = 0;
  let expenseCents = 0; // negative values

  const lines = entries.map((entry: LedgerEntryRow) => {
    const sign = entry.amount_cents >= 0 ? '+' : '-';
    if (entry.amount_cents >= 0) {
      incomeCents += entry.amount_cents;
    } else {
      expenseCents += entry.amount_cents;
    }
    const amountAbs = Math.abs(entry.amount_cents) / 100;
    const occurredAt = new Date(entry.occurred_at_ms).toLocaleString();
    return `${occurredAt} ${entry.title} ${sign}$${amountAbs.toFixed(2)}`;
  });

  const income = (incomeCents / 100).toFixed(2);
  const expense = (Math.abs(expenseCents) / 100).toFixed(2);
  const net = ((incomeCents + expenseCents) / 100).toFixed(2);

  const header = `範圍：${start.toISOString().slice(0, 10)} 至 ${end.toISOString().slice(0, 10)}\n收入：$${income}  支出：-$${expense}  淨額：$${net}`;
  const body = lines.length ? lines.join('\n') : '（無資料）';
  return `${header}\n${body}`;
}

export function buildLedgerProposalFields(params: {
  parsed: { kind: 'add' | 'sub'; item: string; amount: number; occurredAtMs: number };
  userId: string;
  sessionId: string;
  now: Date;
}): { userId: string; sessionId: string; title: string; amountCents: number; occurredAtMs: number; explain: string } {
  const { parsed, userId, sessionId, now } = params;
  
  // 1. 計算金額（加上正負號）
  const sign = parsed.kind === 'add' ? 1 : -1;
  const amountCents = Math.round(Number(parsed.amount) * 100) * sign;
  
  // 2. 驗證時間戳（如果 AI 返回的無效，就用當前時間）
  let occurredAtMs: number;
  if (Number.isFinite(parsed.occurredAtMs) && parsed.occurredAtMs > 0) {
    // 檢查時間戳合理性（不能是未來太遠，也不能是過去太遠）
    const maxFutureMs = now.getTime() + 24 * 60 * 60 * 1000; // 最多未來1天
    const minPastMs = now.getTime() - 365 * 24 * 60 * 60 * 1000; // 最多過去1年
    
    if (parsed.occurredAtMs < minPastMs || parsed.occurredAtMs > maxFutureMs) {
      console.warn(`[buildLedgerProposalFields] Suspicious timestamp: ${parsed.occurredAtMs}, using current time instead`);
      occurredAtMs = now.getTime();
    } else {
      occurredAtMs = parsed.occurredAtMs;
    }
  } else {
    console.warn(`[buildLedgerProposalFields] Invalid timestamp: ${parsed.occurredAtMs}, using current time instead`);
    occurredAtMs = now.getTime();
  }
  
  // 3. 格式化標題
  const title = String(parsed.item ?? '項目');
  
  // 4. 生成說明文字
  const explain = `${title} ${amountCents >= 0 ? '+' : ''}${(amountCents / 100).toFixed(2)}，時間 ${new Date(occurredAtMs).toLocaleString()}`;

  return { userId, sessionId, title, amountCents, occurredAtMs, explain };
}


