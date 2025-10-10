import { z } from 'zod';
import { Agent, run, tool } from '@openai/agents';
import { setDefaultOpenAIKey } from '@openai/agents-openai';
import { insertLedgerEntry, listLedgerEntriesByRange, LedgerEntryRow } from '../utils/db';

export interface GenerateReplyArgs {
  userMessage: string;
}

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
});

function ensureOpenAI() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Missing env: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  setDefaultOpenAIKey(parsed.data.OPENAI_API_KEY);
}

// 使用 @openai/agents 產生回覆（在 worker 執行）
export async function generateReply(args: GenerateReplyArgs): Promise<string> {
  ensureOpenAI();

  // 建立一個簡潔的聊天 Agent（可根據需求調整模型與設定）
  const agent = new Agent({
    name: 'Chat Agent',
    instructions: '你是簡潔且有幫助的助理。',
    // 若未指定 model，會使用預設（一般為 gpt-4.1 / 由 SDK 解析）
  });

  const result = await run(agent, args.userMessage);
  const out = result.finalOutput;
  if (typeof out === 'string') return out;
  return '（助理沒有回覆文字）';
}

// 使用工具的 Agent（加入天氣查詢）
export async function generateReplyWithTools(args: GenerateReplyArgs): Promise<string> {
  ensureOpenAI();

  const WeatherParams = z.object({
    city: z.string().describe('城市名稱，例如 Taipei'),
  });

  const weatherTool = tool({
    name: 'weather',
    description: '查詢某城市的即時氣溫與天氣狀況',
    parameters: WeatherParams,
    execute: async (input) => {
      const { city } = WeatherParams.parse(input);
      console.log('weatherTool', input);
      const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`).then((r) => r.json() as any);
      const weather = res?.current_condition?.[0];
      if (!weather) return `無法取得 ${city} 的天氣資訊`;
      const desc = weather.weatherDesc?.[0]?.value ?? '';
      const temp = weather.temp_C ?? '?';
      return `${city} 現在約 ${temp}°C，天氣狀況：${desc}`;
    },
  });

  const agent = new Agent({
    name: 'Tool-enabled Chat Agent',
    instructions: '你是有工具可用的助理，必要時可呼叫 weather 取得天氣。',
    tools: [weatherTool],
  });

  const result = await run(agent, args.userMessage);
  const out = result.finalOutput;
  if (typeof out === 'string') return out;
  return '（助理沒有回覆文字）';
}

// ===== Ledger: parse intent =====
export const LedgerProposalSchema = z.object({
  userId: z.string().min(1),
  sessionId: z.string().optional().nullable(),
  title: z.string().min(1),
  amountCents: z.number().int(),
  occurredAtMs: z.number().int(),
});
export type LedgerProposal = z.infer<typeof LedgerProposalSchema>;

export async function parseLedgerProposal(args: { userId: string; sessionId?: string | null; text: string; nowMs?: number }): Promise<
  { proposal: LedgerProposal; explain: string }
> {
  ensureOpenAI();

  const now = new Date(args.nowMs ?? Date.now());
  const agent = new Agent({
    name: 'Ledger Parser',
    instructions:
      '你負責從中文或英文記帳指令中抽取結構化資料，或判斷是否是查詢指令。' +
      '\n若是新增/扣除記帳：請自動判斷是【收入】或【支出】並輸出 { kind: "add"|"sub", item: string, amount: number, currency: "TWD", occurredAt: ISO8601 }。' +
      '\n判斷規則：\n- 餐飲/交通/購物/娛樂/房租/水電等一般消費 → 視為支出 (sub)。\n- 薪資/退款/轉入/收款/報銷/利息等 → 視為收入 (add)。\n- 如果文字金額有負號，優先視為支出；有「收入/入帳/進帳」語意優先視為收入；同時出現時以語意為準。' +
      '\n金額可含貨幣符號（如 $、NT$），請解析為數值；單位一律視為 TWD。' +
      '\n若是查詢：輸出 { kind: "query", range: "today"|"yesterday"|"date"|"month"|"week", date?: YYYY-MM-DD }。' +
      `\n今天日期為 ${now.toISOString().slice(0, 10)}，時間請盡量解析成 ISO 日期時間。` +
      '\n只輸出 JSON，勿加說明。',
  });
  const raw = String((await run(agent, args.text)).finalOutput || '').trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.kind === 'add' || parsed?.kind === 'sub') {
      const sign = parsed.kind === 'add' ? 1 : -1;
      const amountCents = Math.round(Number(parsed.amount) * 100) * sign;
      const occurredAtMs = Number(new Date(parsed.occurredAt).getTime());
      const proposal: LedgerProposal = {
        userId: args.userId,
        sessionId: args.sessionId ?? null,
        title: String(parsed.item ?? '項目'),
        amountCents,
        occurredAtMs: Number.isFinite(occurredAtMs) ? occurredAtMs : now.getTime(),
      };
      LedgerProposalSchema.parse(proposal);
      const explain = `${proposal.title} ${amountCents >= 0 ? '+' : ''}${(proposal.amountCents / 100).toFixed(2)}，時間 ${new Date(
        proposal.occurredAtMs
      ).toLocaleString()}`;
      return { proposal, explain };
    }
    throw new Error('Not a ledger proposal');
  } catch (err: any) {
    throw new Error(`parseLedgerProposal failed: ${err?.message ?? 'unknown error'}`);
  }
}

export async function queryLedgerRange(args: { userId: string; text: string; nowMs?: number }): Promise<
  { resultText: string }
> {
  ensureOpenAI();

  const now = new Date(args.nowMs ?? Date.now());
  const agent = new Agent({
    name: 'Ledger Query Parser',
    instructions:
      '你負責從中文或英文的查帳指令中抽取查詢區間。' +
      '\n輸出 JSON 欄位 { kind: "query", range: "today"|"yesterday"|"date"|"month"|"week", date?: YYYY-MM-DD }。' +
      `\n今天日期為 ${now.toISOString().slice(0, 10)}，時間請盡量解析成 ISO 日期時間。` +
      '\n只輸出 JSON，勿加說明。',
  });
  const raw = String((await run(agent, args.text)).finalOutput || '').trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.kind === 'query') {
      const base = new Date(now);
      base.setHours(0, 0, 0, 0);

      // 小工具：時間範圍計算（[start, end)）
      const startOfDay = (d: Date) => {
        const t = new Date(d);
        t.setHours(0, 0, 0, 0);
        return t;
      };
      const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
      const startOfMonth = (d: Date) => {
        const t = new Date(d);
        t.setDate(1);
        t.setHours(0, 0, 0, 0);
        return t;
      };
      const addMonths = (d: Date, n: number) => {
        const t = new Date(d);
        t.setMonth(t.getMonth() + n);
        return t;
      };
      const startOfWeekMon = (d: Date) => {
        const t = startOfDay(d);
        const day = t.getDay(); // 0 Sun .. 6 Sat
        const diff = (day + 6) % 7; // Monday=0
        return addDays(t, -diff);
      };

      const range = String(parsed.range);
      let start: Date;
      let end: Date;
      if (range === 'today') {
        start = startOfDay(base);
        end = addDays(start, 1);
      } else if (range === 'yesterday') {
        end = startOfDay(base);
        start = addDays(end, -1);
      } else if (range === 'date') {
        const d = new Date(parsed.date);
        if (isNaN(d.getTime())) throw new Error('Invalid date');
        start = startOfDay(d);
        end = addDays(start, 1);
      } else if (range === 'week') {
        const d = parsed.date ? new Date(parsed.date) : base;
        const weekStart = startOfWeekMon(d);
        start = weekStart;
        end = addDays(weekStart, 7);
      } else if (range === 'month') {
        const d = parsed.date ? new Date(parsed.date + '-01') : base;
        start = startOfMonth(d);
        end = addMonths(start, 1);
      } else {
        throw new Error('Unsupported range');
      }

      // 列出範圍內所有收入與支出，並計算加總
      const entries = listLedgerEntriesByRange(args.userId, start.getTime(), end.getTime());
      let incomeCents = 0;
      let expenseCents = 0; // 負數
      const lines = entries.map((e: LedgerEntryRow) => {
        const sign = e.amount_cents >= 0 ? '+' : '-';
        if (e.amount_cents >= 0) incomeCents += e.amount_cents; else expenseCents += e.amount_cents;
        const amt = Math.abs(e.amount_cents) / 100;
        const time = new Date(e.occurred_at_ms).toLocaleString();
        return `${time} ${e.title} ${sign}$${amt.toFixed(2)}`;
      });
      const income = (incomeCents / 100).toFixed(2);
      const expense = (Math.abs(expenseCents) / 100).toFixed(2);
      const net = ((incomeCents + expenseCents) / 100).toFixed(2);
      const header = `範圍：${start.toISOString().slice(0, 10)} 至 ${end.toISOString().slice(0, 10)}\n收入：$${income}  支出：-$${expense}  淨額：$${net}`;
      const body = lines.length ? lines.join('\n') : '（無資料）';
      const text = `${header}\n${body}`;
      return { resultText: text };
    }
    throw new Error('Not a ledger query');
  } catch (err: any) {
    throw new Error(`queryLedgerRange failed: ${err?.message ?? 'unknown error'}`);
  }
}

export async function saveLedger(args: { proposal: LedgerProposal }): Promise<string> {
  insertLedgerEntry({
    userId: args.proposal.userId,
    sessionId: args.proposal.sessionId ?? null,
    title: args.proposal.title,
    amountCents: args.proposal.amountCents,
    occurredAtMs: args.proposal.occurredAtMs,
    createdAtMs: Date.now(),
  });
  return '已存入記帳';
}

// 決策可用功能：聊天、查天氣、記帳、查帳
export type Capability = 'chat' | 'weather' | 'ledger_proposal' | 'ledger_query';
export async function decideCapability(args: { text: string }): Promise<Capability> {
  ensureOpenAI();
  const schema = z.object({ type: z.enum(['chat', 'weather', 'ledger_proposal', 'ledger_query']) });
  const agent = new Agent({
    name: 'Capability Router',
    instructions:
      '請判斷使用者訊息應該走哪個功能，僅輸出 JSON：{"type":"chat|weather|ledger_proposal|ledger_query"}。\n' +
      '- 一般對話 → chat\n- 問天氣、氣溫、下雨、晴、°C → weather\n' +
      '- 記帳新增/扣除 → ledger_proposal\n- 查詢當日/昨日/特定日期/當月花費 → ledger_query',
  });
  const out = await run(agent, args.text);
  try {
    const parsed = schema.parse(typeof out.finalOutput === 'string' ? JSON.parse(out.finalOutput) : out.finalOutput);
    return parsed.type;
  } catch {
    return 'chat';
  }
}
