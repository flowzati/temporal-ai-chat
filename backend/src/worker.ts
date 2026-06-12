import 'dotenv/config';
import { Worker } from '@temporalio/worker';
import * as activities from './temporal/activities';
import { loadConfig } from './utils/env';
// Worker：掛載 workflows 與 activities，負責執行工作流任務與活動呼叫

async function run() {
  const { temporalTaskQueue } = loadConfig();

  // 1. 建立 worker
  const worker = await Worker.create({
    // 2. 載入 workflows (流程定義，推進流程)
    workflowsPath: require.resolve('./temporal/workflows'),
    // 3. 載入 activities (活動呼叫，執行任務)
    activities,
    // 4. 指定目標 Task Queue (與啟動工作流時相同)
    taskQueue: temporalTaskQueue,
  });

  console.log(`[worker] Starting worker on taskQueue="${temporalTaskQueue}"`);
  // 5. 啟動 worker
  await worker.run();
}

run().catch((err) => {
  console.error('[worker] Failed:', err);
  process.exit(1);
});
