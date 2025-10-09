import { z } from 'zod';
import { Agent, run } from '@openai/agents';
import { setDefaultOpenAIKey } from '@openai/agents-openai';

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
