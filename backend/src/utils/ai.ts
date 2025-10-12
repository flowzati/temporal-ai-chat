import { z } from 'zod';
import { Agent, run } from '@openai/agents';
import { setDefaultOpenAIKey } from '@openai/agents-openai';
import * as ledger from '../utils/ledger';
import { Capability, ParsedLedgerProposalResult, LedgerQueryRangeResult, LedgerRangeInput } from '../types';

const EnvSchema = z.object({ OPENAI_API_KEY: z.string().min(1) });

let openaiInitialized = false;
export function initOpenAIOnce(): void {
  if (openaiInitialized) return;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Missing env: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  setDefaultOpenAIKey(parsed.data.OPENAI_API_KEY);
  openaiInitialized = true;
}

// Initialize at module load; subsequent API calls无需再次驗證
initOpenAIOnce();

export async function decideCapability(userMessage: string): Promise<Capability> {
  const schema = z.object({ type: z.enum(['chat', 'weather', 'ledger_proposal', 'ledger_query', 'ledger_undo']) });
  const agent = new Agent({
    name: 'Capability Router',
    instructions:
      '請判斷使用者訊息應該走哪個功能，僅輸出 JSON：{"type":"chat|weather|ledger_proposal|ledger_query|ledger_undo"}。\n' +
      '- 一般對話 → chat\n' +
      '- 問天氣、氣溫、下雨、晴、°C → weather\n' +
      '- 記帳新增/扣除 → ledger_proposal\n' +
      '- 查詢當日/昨日/特定日期/當月花費 → ledger_query\n' +
      '- 撤銷/刪除最近一筆記帳（例如：「撤銷」、「刪除上一筆」、「取消記帳」、「記錯了」） → ledger_undo',
  });
  const out = await run(agent, userMessage);
  const parsed = schema.parse(typeof out.finalOutput === 'string' ? JSON.parse(out.finalOutput) : out.finalOutput);
  return parsed.type as Capability;
}

export async function chatReply(userMessage: string): Promise<string> {
  const agent = new Agent({ name: 'Chat Agent', instructions: '你是簡潔且有幫助的助理。' });
  const result = await run(agent, userMessage);
  const out = result.finalOutput;
  if (typeof out === 'string') return out;
  return '（助理沒有回覆文字）';
}

export async function weatherReply(userMessage: string): Promise<string> {
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
  const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`).then((r) => r.json() as any);
  const weather = res?.current_condition?.[0];
  if (!weather) throw new Error(`無法取得 ${city} 的天氣資訊`);
  const desc = weather.weatherDesc?.[0]?.value ?? '';
  const temp = weather.temp_C ?? '?';
  return `${city} 現在約 ${temp}°C，天氣狀況：${desc}`;
}

export async function parseLedgerProposal(userMessage: string, userId: string, sessionId: string): Promise<ParsedLedgerProposalResult> {
  const now = new Date();
  const nowMs = now.getTime();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  
  const agent = new Agent({
    name: 'Ledger Parser',
    instructions:
      '你負責從中文或英文記帳指令中抽取結構化資料。' +
      '\n輸出格式：{ kind: "add"|"sub", item: string, amount: number, currency: "TWD", occurredAtMs: number }' +
      '\n\n【重要】時間解析規則（occurredAtMs 是 Unix timestamp 毫秒數）：' +
      `\n1. 沒有提到時間 → 使用當前時間：${nowMs}` +
      `\n   範例：「買了午餐100元」 → occurredAtMs: ${nowMs}` +
      `\n\n2. 提到「今天」/「今日」但沒說幾點 → 使用今天 00:00:00：${todayStart}` +
      `\n   範例：「今天買了午餐」 → occurredAtMs: ${todayStart}` +
      `\n\n3. 提到「今天」+具體時間 → 計算該時刻的 timestamp` +
      `\n   範例：「今天中午12點買了午餐」 → occurredAtMs: ${todayStart + 12 * 60 * 60 * 1000}` +
      `\n   範例：「今天下午3點半」 → occurredAtMs: ${todayStart + 15.5 * 60 * 60 * 1000}` +
      `\n\n4. 提到「昨天」/「昨日」但沒說幾點 → 使用昨天 00:00:00：${yesterdayStart}` +
      `\n   範例：「昨天買了晚餐」 → occurredAtMs: ${yesterdayStart}` +
      `\n\n5. 提到「昨天」+具體時間 → 計算該時刻的 timestamp` +
      `\n   範例：「昨天晚上8點」 → occurredAtMs: ${yesterdayStart + 20 * 60 * 60 * 1000}` +
      `\n\n6. 提到具體日期但沒說幾點 → 使用該日期 00:00:00` +
      `\n   範例：「1月15日買了東西」 → occurredAtMs: ${new Date(now.getFullYear(), 0, 15).getTime()}` +
      `\n\n7. 提到具體日期+時間 → 計算該時刻的 timestamp` +
      `\n   範例：「1月15日下午2點」 → occurredAtMs: ${new Date(now.getFullYear(), 0, 15, 14, 0).getTime()}` +
      '\n\n判斷收支規則：' +
      '\n- 餐飲/交通/購物/娛樂/房租/水電等消費 → 支出 (sub)' +
      '\n- 薪資/退款/轉入/收款/報銷/利息等 → 收入 (add)' +
      '\n- 金額可含貨幣符號（$、NT$），解析為數值，單位為 TWD' +
      '\n\n參考資訊：' +
      `\n- 當前完整時間：${now.toISOString()} (${nowMs}ms)` +
      `\n- 今天日期：${now.toISOString().slice(0, 10)}` +
      `\n- 今年：${now.getFullYear()}年` +
      '\n\n注意：' +
      '\n1. occurredAtMs 必須是數字（Unix timestamp 毫秒）' +
      '\n2. 只輸出 JSON，勿加說明' +
      '\n3. 時間計算要準確，考慮年月日時分秒',
  });
  
  const raw = String((await run(agent, userMessage)).finalOutput || '').trim();
  const parsed = JSON.parse(raw);
  if (parsed?.kind === 'add' || parsed?.kind === 'sub') {
    const built = ledger.buildLedgerProposalFields({ parsed, userId: userId, sessionId: sessionId, now });
    return {
      userId: built.userId,
      sessionId: built.sessionId,
      title: built.title,
      amountCents: built.amountCents,
      occurredAtMs: built.occurredAtMs,
      explain: `${built.title} ${built.amountCents >= 0 ? '+' : ''}${(built.amountCents / 100).toFixed(2)}，時間 ${new Date(
        built.occurredAtMs
      ).toLocaleString()}`,
    };
  }
  throw new Error('Not a ledger proposal');
}

export async function queryLedgerRange(userMessage: string): Promise<LedgerQueryRangeResult> {
  const now = new Date();
  const agent = new Agent({
    name: 'Ledger Query Parser',
    instructions:
      '你負責從中文或英文的查帳指令中抽取查詢區間。' +
      '\n輸出 JSON 欄位 { kind: "query", range: "today"|"yesterday"|"date"|"month"|"week", date?: YYYY-MM-DD }。' +
      `\n今天日期為 ${now.toISOString().slice(0, 10)}，時間請盡量解析成 ISO 日期時間。` +
      '\n只輸出 JSON，勿加說明。',
  });
  const raw = String((await run(agent, userMessage)).finalOutput || '').trim();
  const parsed = JSON.parse(raw);
  if (parsed?.kind === 'query') {
    const range = parsed.range as LedgerRangeInput['range'];
    const { start, end } = ledger.computeLedgerRange({ range, date: parsed.date }, now);
    return { startMs: start.getTime(), endMs: end.getTime() };
  }
  throw new Error('Not a ledger query');
}


