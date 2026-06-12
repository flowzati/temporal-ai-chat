import { Client, WorkflowHandle } from '@temporalio/client';
import { SendMessageParams } from '../types';

const CHAT_WORKFLOW = {
  name: 'chatSessionWorkflow',
  idPrefix: 'chat-session-',
  updates: {
    sendMessage: 'sendMessage',
  },
  signals: {
    cancel: 'cancel',
    close: 'close',
  },
} as const;

function isWorkflowNotFoundError(error: any): boolean {
  return (
    error.message?.includes('not found') ||
    error.message?.includes('workflow execution already completed')
  );
}

function hasWorkflowCompletedDuringUpdate(error: any): boolean {
  let current = error;
  while (current) {
    const message = String(current.message ?? '');
    const type = String(current.type ?? '');
    if (
      type === 'AcceptedUpdateCompletedWorkflow' ||
      message.includes('Workflow completed before the Update completed') ||
      message.includes('Workflow Update failed because the Workflow completed')
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export class ChatWorkflowClient {
  private workflowCache = new Map<string, WorkflowHandle>();

  constructor(
    private readonly client: Client,
    private readonly taskQueue: string
  ) {}

  private getWorkflowId(sessionId: string): string {
    return `${CHAT_WORKFLOW.idPrefix}${sessionId}`;
  }

  private getWorkflowHandle(sessionId: string): WorkflowHandle {
    const workflowId = this.getWorkflowId(sessionId);
    let handle = this.workflowCache.get(workflowId);

    if (!handle) {
      handle = this.client.workflow.getHandle(workflowId);
      this.workflowCache.set(workflowId, handle);
    }

    return handle;
  }

  private async startSessionWorkflow(sessionId: string, startedAtMs: number): Promise<WorkflowHandle> {
    const workflowId = this.getWorkflowId(sessionId);
    const handle = await this.client.workflow.start(CHAT_WORKFLOW.name, {
      args: [{ sessionId, startedAtMs }],
      taskQueue: this.taskQueue,
      workflowId,
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    });

    this.workflowCache.set(workflowId, handle);
    return handle;
  }

  private async executeWorkflowOperation<T>(
    sessionId: string,
    operation: (handle: WorkflowHandle) => Promise<T>
  ): Promise<T> {
    const workflowId = this.getWorkflowId(sessionId);
    let handle = this.getWorkflowHandle(sessionId);

    try {
      return await operation(handle);
    } catch (error: any) {
      if (isWorkflowNotFoundError(error) || hasWorkflowCompletedDuringUpdate(error)) {
        console.log(`[ChatWorkflowClient] Workflow unavailable, creating: ${sessionId}`);
        this.workflowCache.delete(workflowId);
        handle = await this.startSessionWorkflow(sessionId, Date.now());
        return await operation(handle);
      }
      throw error;
    }
  }

  async sendMessage(params: SendMessageParams): Promise<string> {
    return await this.executeWorkflowOperation(params.sessionId, async (handle) => {
      const reply = await handle.executeUpdate(CHAT_WORKFLOW.updates.sendMessage, {
        args: [params],
        ...(params.requestId && { updateId: params.requestId }),
      });
      return reply as string;
    });
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.executeWorkflowOperation(sessionId, (handle) =>
      handle.signal(CHAT_WORKFLOW.signals.cancel)
    );
  }

  async closeSessionIfRunning(sessionId: string, cutoffMs: number): Promise<boolean> {
    const workflowId = this.getWorkflowId(sessionId);
    const handle = this.getWorkflowHandle(sessionId);

    try {
      await handle.signal(CHAT_WORKFLOW.signals.close, cutoffMs);
      this.workflowCache.delete(workflowId);
      return true;
    } catch (error: any) {
      if (isWorkflowNotFoundError(error) || hasWorkflowCompletedDuringUpdate(error)) {
        this.workflowCache.delete(workflowId);
        return false;
      }
      throw error;
    }
  }
}
