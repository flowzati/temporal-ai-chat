import 'dotenv/config';
import { Worker } from '@temporalio/worker';
import * as activities from './temporal/activities';
// Worker：掛載 workflows 與 activities，負責執行工作流任務與活動呼叫

async function run() {
  const taskQueue = 'chat-ai'; // 工作佇列名稱，與啟動工作流時相同

  // 建立並啟動 worker，掛載工作流與活動
  const worker = await Worker.create({
    workflowsPath: require.resolve('./temporal/workflows'),
    activities,
    taskQueue,
  });

  console.log(`[worker] Starting worker on taskQueue="${taskQueue}"`);
  await worker.run();
}

run().catch((err) => {
  console.error('[worker] Failed:', err);
  process.exit(1);
});
