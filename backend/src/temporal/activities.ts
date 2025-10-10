import { z } from 'zod';
import { Agent, run, tool } from '@openai/agents';
import { setDefaultOpenAIKey } from '@openai/agents-openai';
import { insertLedgerEntry, listLedgerEntriesByRange, sumLedgerEntriesByRange } from '../utils/db';

export interface GenerateReplyArgs {
  userMessage: string;
}

export interface DecideUseToolsArgs {
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

// 讓 OpenAI 幫忙判斷是否需要使用工具（目前工具為 weather）
export async function decideUseTools(args: DecideUseToolsArgs): Promise<boolean> {
  ensureOpenAI();

  const agent = new Agent({
    name: 'Tool Decision Agent',
    instructions:
      '你是決策器。判斷使用者訊息是否需要使用可用工具解決（目前只有天氣 weather 工具）。只輸出 yes 或 no。\n' +
      '例如：問天氣、溫度、下雨、晴、°C 等屬於需要工具。其他一般聊天則不需要工具。',
  });

  const result = await run(agent, args.userMessage);
  const out = String(result.finalOutput || '').trim().toLowerCase();
  console.log('decideUseTools', out);
  if (out.includes('yes')) return true;
  if (out.includes('no')) return false;
  // 若無法判斷，保守回傳不使用工具
  return false;
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

export async function parseLedgerIntent(args: { userId: string; sessionId?: string | null; text: string; nowMs?: number }): Promise<
  | { type: 'none' }
  | { type: 'proposal'; proposal: LedgerProposal; explain: string }
  | { type: 'query'; resultText: string }
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
      '\n若是查詢：輸出 { kind: "query", range: "today"|"yesterday"|"date"|"month", date?: YYYY-MM-DD }。' +
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
      return { type: 'proposal', proposal, explain };
    }
    if (parsed?.kind === 'query') {
      const range = String(parsed.range);
      let start: Date;
      let end: Date;
      const base = new Date(now);
      base.setHours(0, 0, 0, 0);
      if (range === 'today') {
        start = new Date(base);
        end = new Date(base);
        end.setDate(end.getDate() + 1);
      } else if (range === 'yesterday') {
        end = new Date(base);
        start = new Date(base);
        start.setDate(start.getDate() - 1);
      } else if (range === 'date') {
        const d = new Date(parsed.date);
        start = new Date(d);
        start.setHours(0, 0, 0, 0);
        end = new Date(start);
        end.setDate(end.getDate() + 1);
      } else if (range === 'month') {
        const d = parsed.date ? new Date(parsed.date + '-01') : new Date(base);
        start = new Date(d);
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
        end = new Date(start);
        end.setMonth(end.getMonth() + 1);
      } else {
        return { type: 'none' };
      }
      const total = sumLedgerEntriesByRange(args.userId, start.getTime(), end.getTime());
      const text = `總額：$${(total / 100).toFixed(2)}（${start.toISOString().slice(0, 10)} 至 ${end.toISOString().slice(0, 10)}）`;
      return { type: 'query', resultText: text };
    }
  } catch {}
  return { type: 'none' };
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
