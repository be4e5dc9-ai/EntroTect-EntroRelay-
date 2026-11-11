import type { ContextUsage, Conversation } from '../shared/types';

const tokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function providerTotal(usage: any): number | undefined {
  const total = tokenCount(usage?.totalTokens);
  if (total !== undefined) return total;
  const input = tokenCount(usage?.inputTokens);
  if (input === undefined) return undefined;
  return input + (tokenCount(usage.outputTokens) ?? 0)
    + (tokenCount(usage.cacheReadTokens) ?? 0) + (tokenCount(usage.cacheWriteTokens) ?? 0);
}

/** Latest pressure for the next turn, never the sum of calls in a conversation. */
export class ContextUsageProjection {
  private windowTokens?: number;
  private readonly route: Pick<ContextUsage, 'harness' | 'modelId' | 'revision'>;
  constructor(conversation: Conversation, modelId: string) {
    this.route = { harness: conversation.harness, modelId, revision: conversation.revision };
    const previous = conversation.contextUsage;
    if (previous?.harness === this.route.harness && previous.modelId === modelId &&
        previous.revision === conversation.revision - 1) this.windowTokens = previous.windowTokens;
  }

  deepseek(event: any): ContextUsage | undefined {
    if (event.type === 'request/context') {
      this.windowTokens = tokenCount(event.data?.contextWindow);
    } else if (event.type === 'assistant/message') {
      return this.snapshot(providerTotal(event.data?.usage), 'reported');
    }
  }

  zcode(event: any): ContextUsage | undefined {
    const data = event.payload;
    if (event.type !== 'session.updated' || !data) return;
    const window = tokenCount(data.contextWindow);
    if (window) this.windowTokens = window;
    if (data.status === 'completed' && data.operationId && data.compactReason) {
      return this.snapshot(tokenCount(data.truePostCompactTokenCount) ?? tokenCount(data.postCompactTokenCount), 'native-estimate');
    }
    if (window && data.querySource !== 'compact') {
      return this.snapshot(providerTotal(data.usage), 'reported');
    }
  }

  native(result: { usedTokens?: unknown; windowTokens?: unknown } | null): ContextUsage | undefined {
    if (!result) return;
    this.windowTokens = tokenCount(result.windowTokens);
    return this.snapshot(tokenCount(result.usedTokens), 'native-estimate');
  }

  agent(frame: any): ContextUsage | undefined {
    if (frame.method === 'thread/tokenUsage/updated') {
      const usage = frame.params?.tokenUsage;
      this.windowTokens = tokenCount(usage?.modelContextWindow) ?? this.windowTokens;
      return this.snapshot(providerTotal(usage?.last), 'reported');
    }
    const update = frame.params?.update;
    if (frame.method === 'session/update' && update?.sessionUpdate === 'usage_update') {
      return this.native({ usedTokens: update.used, windowTokens: update.size });
    }
  }

  private snapshot(usedTokens: number | undefined, source: ContextUsage['source']): ContextUsage | undefined {
    if (!this.windowTokens || usedTokens === undefined) return;
    return { ...this.route, usedTokens, windowTokens: this.windowTokens, source };
  }
}
