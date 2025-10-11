import { Connection, Client } from '@temporalio/client';

/**
 * 创建 Temporal Client
 */
export async function createTemporalClient(address: string, namespace: string): Promise<Client> {
  const connection = await Connection.connect({ address });
  return new Client({ connection, namespace });
}

