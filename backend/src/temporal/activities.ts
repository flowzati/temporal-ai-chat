import { z } from 'zod';
import { Agent, run, tool } from '@openai/agents';
import { setDefaultOpenAIKey } from '@openai/agents-openai';

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
  if (out.includes('yes')) return true;
  if (out.includes('no')) return false;
  // 若無法判斷，保守回傳不使用工具
  return false;
}
