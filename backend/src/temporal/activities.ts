import { z } from 'zod';
import { Agent, run } from '@openai/agents';
import { setDefaultOpenAIKey } from '@openai/agents-openai';
import { insertLedgerEntry, listLedgerEntriesByRange } from '../utils/db';
import { computeLedgerRange, formatLedgerSummary, buildLedgerProposalFields, LedgerRangeInput } from '../utils/ledger';
import { ParsedLedgerProposalFlat, Capability, SendMessageArgs } from '../types';

// Removed ChatReplyArgs; use plain string parameters

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

// 決策可用功能：聊天、查天氣、記帳、查帳
export async function decideCapability(text: string): Promise<Capability> {
  ensureOpenAI();
  const schema = z.object({ type: z.enum(['chat', 'weather', 'ledger_proposal', 'ledger_query']) });
  const agent = new Agent({
    name: 'Capability Router',
    instructions:
      '請判斷使用者訊息應該走哪個功能，僅輸出 JSON：{"type":"chat|weather|ledger_proposal|ledger_query"}。\n' +
      '- 一般對話 → chat\n- 問天氣、氣溫、下雨、晴、°C → weather\n' +
      '- 記帳新增/扣除 → ledger_proposal\n- 查詢當日/昨日/特定日期/當月花費 → ledger_query',
  });
  const out = await run(agent, text);
  try {
    const parsed = schema.parse(typeof out.finalOutput === 'string' ? JSON.parse(out.finalOutput) : out.finalOutput);
    return parsed.type;
  } catch {
    return 'chat';
  }
}

// 使用 @openai/agents 產生回覆（在 worker 執行）
export async function chatReply(userMessage: string): Promise<string> {
  ensureOpenAI();
  const agent = new Agent({
    name: 'Chat Agent',
    instructions: '你是簡潔且有幫助的助理。',
  });
  const result = await run(agent, userMessage);
  const out = result.finalOutput;
  if (typeof out === 'string') return out;
  return '（助理沒有回覆文字）';
}

// 使用工具的 Agent（加入天氣查詢）
export async function weatherReply(userMessage: string): Promise<string> {
  // 改為專責天氣回覆（不使用 tools）
  ensureOpenAI();
  const CitySchema = z.object({ city: z.string().min(1) });
  const extractor = new Agent({
    name: 'City Extractor',
    instructions: '從使用者訊息中抽取欲查詢天氣的城市，只輸出 JSON:{"city":"Taipei"}；若無則 {"city":""}。',
  });
  const raw = String((await run(extractor, userMessage)).finalOutput || '').trim();
  let city = '';
  try {
    const parsed = CitySchema.safeParse(JSON.parse(raw));
    city = parsed.success ? parsed.data.city : '';
  } catch {
    city = '';
  }
  if (!city) return '請提供要查詢天氣的城市名稱，例如：台北天氣如何？';
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`).then((r) => r.json() as any);
    const weather = res?.current_condition?.[0];
    if (!weather) return `無法取得 ${city} 的天氣資訊`;
    const desc = weather.weatherDesc?.[0]?.value ?? '';
    const temp = weather.temp_C ?? '?';
    return `${city} 現在約 ${temp}°C，天氣狀況：${desc}`;
  } catch (err: any) {
    return `查詢 ${city} 天氣時發生錯誤：${err?.message ?? '未知錯誤'}`;
  }
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

export interface ParseLedgerProposalResult {
  proposal: LedgerProposal;
  explain: string;
}

export async function parseLedgerProposal(args: SendMessageArgs): Promise<ParsedLedgerProposalFlat> {
  ensureOpenAI();
  // Use activity-time instead of workflow-time; determinism is preserved in workflow
  const now = new Date();
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
  const raw = String((await run(agent, args.userMessage)).finalOutput || '').trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.kind === 'add' || parsed?.kind === 'sub') {
      const built = buildLedgerProposalFields({
        parsed,
        userId: args.userId,
        sessionId: args.sessionId ?? null,
        now,
      });
      const proposal: LedgerProposal = {
        userId: built.userId,
        sessionId: built.sessionId,
        title: built.title,
        amountCents: built.amountCents,
        occurredAtMs: built.occurredAtMs,
      };
      LedgerProposalSchema.parse(proposal);
      return { userId: proposal.userId, sessionId: proposal.sessionId, title: proposal.title, amountCents: proposal.amountCents, occurredAtMs: proposal.occurredAtMs, explain: built.explain };
    }
    throw new Error('Not a ledger proposal');
  } catch (err: any) {
    throw new Error(`parseLedgerProposal failed: ${err?.message ?? 'unknown error'}`);
  }
}

export async function queryLedgerRange(args: SendMessageArgs): Promise<string> {
  ensureOpenAI();
  const now = new Date();
  const agent = new Agent({
    name: 'Ledger Query Parser',
    instructions:
      '你負責從中文或英文的查帳指令中抽取查詢區間。' +
      '\n輸出 JSON 欄位 { kind: "query", range: "today"|"yesterday"|"date"|"month"|"week", date?: YYYY-MM-DD }。' +
      `\n今天日期為 ${now.toISOString().slice(0, 10)}，時間請盡量解析成 ISO 日期時間。` +
      '\n只輸出 JSON，勿加說明。',
  });
  const raw = String((await run(agent, args.userMessage)).finalOutput || '').trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.kind === 'query') {
      const range = parsed.range as LedgerRangeInput['range'];
      const { start, end } = computeLedgerRange({ range, date: parsed.date }, now);
      const entries = listLedgerEntriesByRange(args.userId, start.getTime(), end.getTime());
      return formatLedgerSummary(entries, start, end);
    }
    throw new Error('Not a ledger query');
  } catch (err: any) {
    throw new Error(`queryLedgerRange failed: ${err?.message ?? 'unknown error'}`);
  }
}

export async function saveLedger(proposal: LedgerProposal): Promise<string> {
  insertLedgerEntry({
    userId: proposal.userId,
    sessionId: proposal.sessionId ?? null,
    title: proposal.title,
    amountCents: proposal.amountCents,
    occurredAtMs: proposal.occurredAtMs,
    createdAtMs: Date.now(),
  });
  return '已存入記帳';
}
