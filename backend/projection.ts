import type { DisplayItem, Harness } from '../shared/types';

export function textBlocks(blocks: any): string {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
}
export class Projection {
  readonly items = new Map<string, DisplayItem>();
  private attempts = new Map<string, { turn: number; step: number }>();
  constructor(private harness: Harness, private runId: string) {}
  update(id: string, patch: Partial<DisplayItem>): DisplayItem {
    const item: DisplayItem = { id, kind: 'assistant', text: '', harness: this.harness, time: Date.now(), ...this.items.get(id), ...patch };
    this.items.set(id, item); return item;
  }
  agent(frame: any): DisplayItem[] {
    const data = frame.params ?? {};
    const delta = (key: string, kind: 'assistant' | 'reasoning' | 'tool', text: unknown) => {
      if (typeof text !== 'string' || !text) return [];
      const id = `${this.runId}:${key}`;
      return [this.update(id, { kind, text: (this.items.get(id)?.text ?? '') + text })];
    };
    if (frame.method === 'session/update') {
      const update = data.update ?? {};
      switch (update.sessionUpdate) {
        case 'agent_message_chunk': return delta('assistant', 'assistant', update.content?.text);
        case 'agent_thought_chunk': return delta('reasoning', 'reasoning', update.content?.text);
        case 'tool_call': case 'tool_call_update': {
          const id = `${this.runId}:tool:${update.toolCallId}`;
          const content = Array.isArray(update.content) ? update.content.flatMap((item: any) => item.content?.text ?? item.diff ?? []).join('\n') : '';
          const output = content || (typeof update.rawOutput === 'string' ? update.rawOutput : update.rawOutput == null ? '' : JSON.stringify(update.rawOutput, null, 2));
          return [this.update(id, { kind: 'tool', ...(update.title ? { toolName: update.title } : {}),
            ...(update.rawInput !== undefined ? { input: JSON.stringify(update.rawInput, null, 2) } : {}),
            ...(output ? { text: output } : {}), ...(update.status ? { status: update.status === 'failed' ? 'error' : update.status === 'completed' ? 'done' : 'running' } : {}),
          })];
        }
      }
      return [];
    }
    if (frame.method === 'item/agentMessage/delta') return delta(`item:${data.itemId}`, 'assistant', data.delta);
    if (frame.method === 'item/reasoning/summaryTextDelta' || frame.method === 'item/reasoning/textDelta') return delta(`thought:${data.itemId}`, 'reasoning', data.delta);
    if (frame.method === 'item/commandExecution/outputDelta') return delta(`tool:${data.itemId}`, 'tool', data.delta);
    if (frame.method !== 'item/started' && frame.method !== 'item/completed') return [];
    const item = data.item ?? {};
    const status = frame.method === 'item/started' ? 'running' : ['failed', 'declined', 'interrupted'].includes(item.status) ? 'error' : 'done';
    if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text) return [this.update(`${this.runId}:item:${item.id}`, { text: item.text, status })];
    if (item.type === 'exitedReviewMode' && frame.method === 'item/completed' && typeof item.review === 'string') return [this.update(`${this.runId}:review:${item.id}`, { text: item.review, status })];
    if (item.type === 'reasoning' && frame.method === 'item/completed') {
      const text = (Array.isArray(item.summary) ? item.summary : []).filter((part: unknown) => typeof part === 'string').join('\n');
      if (text) return [this.update(`${this.runId}:thought:${item.id}`, { kind: 'reasoning', text, status })];
    }
    if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(item.type)) {
      const output = item.aggregatedOutput ?? item.result ?? item.output;
      return [this.update(`${this.runId}:tool:${item.id}`, { kind: 'tool', toolName: item.tool ?? item.type, input: typeof item.command === 'string' ? item.command : item.arguments !== undefined ? JSON.stringify(item.arguments, null, 2) : undefined,
        ...(output === undefined || output === null ? {} : { text: typeof output === 'string' ? output : JSON.stringify(output, null, 2) }), status })];
    }
    return [];
  }
  deepseekStream(frame: any): DisplayItem[] {
    if (frame.type === 'start') { this.attempts.set(frame.attemptId, { turn: frame.turn, step: frame.step }); return []; }
    const attempt = this.attempts.get(frame.attemptId); if (!attempt || frame.type !== 'chunk') return [];
    const chunk = frame.chunk;
    if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return [];
    const thought = chunk.type === 'reasoning-delta';
    const id = `${this.runId}:assistant:${attempt.turn}:${attempt.step}${thought ? ':thought' : ''}`;
    return [this.update(id, { kind: thought ? 'reasoning' : 'assistant', text: (this.items.get(id)?.text ?? '') + chunk.text })];
  }
  deepseek(event: any): DisplayItem[] {
    const d = event.data ?? {}, out: DisplayItem[] = [];
    if (event.type === 'assistant/message') {
      const key = `${this.runId}:assistant:${d.turn}:${d.step}`;
      const content = d.message?.content ?? [];
      const text = textBlocks(content); if (text) out.push(this.update(key, { text }));
      const thought = content.filter((b: any) => b.type === 'reasoning').map((b: any) => b.text ?? '').join('\n');
      if (thought) out.push(this.update(`${key}:thought`, { kind: 'reasoning', text: thought }));
    } else if (event.type === 'tool/call') {
      out.push(this.update(`${this.runId}:tool:${d.callId}`, { kind: 'tool', toolName: d.name, input: d.arguments, status: 'running' }));
    } else if (event.type === 'tool/result') {
      const message = d.message ?? {};
      out.push(this.update(`${this.runId}:tool:${message.callId ?? message.toolCallId}`, { kind: 'tool', text: textBlocks(message.content), status: message.isError ? 'error' : 'done' }));
    } else if (event.type === 'command/run') {
      out.push(this.update(`${this.runId}:command:${d.commandId}`, { kind: 'command', commandName: d.name, input: d.args, status: 'running' }));
    } else if (event.type === 'command/done') {
      out.push(this.update(`${this.runId}:command:${d.commandId}`, { kind: 'command', text: d.text ?? '', status: d.kind === 'error' ? 'error' : 'done' }));
    } else if (event.type === 'turn/end' && d.reason?.kind === 'error') out.push(this.update(`${this.runId}:error`, { kind: 'error', text: d.reason.error?.message ?? JSON.stringify(d.reason.error) }));
    return out;
  }
  zcode(event: any): DisplayItem[] {
    const p = event.payload ?? {}, out: DisplayItem[] = [];
    if (event.type === 'model.streaming' && (p.kind === 'text_delta' || p.kind === 'reasoning_delta')) {
      const id = `${this.runId}:stream:${p.assistantMessageId ?? event.turnId}:${p.kind}`;
      out.push(this.update(id, { kind: p.kind === 'reasoning_delta' ? 'reasoning' : 'assistant', text: (this.items.get(id)?.text ?? '') + (p.delta ?? '') }));
    } else if (event.type === 'part.delta') {
      const key = `${this.runId}:part:${p.partId}`;
      const previous = this.items.get(key);
      out.push(this.update(key, { kind: p.field === 'reasoning' ? 'reasoning' : previous?.kind ?? 'assistant', text: (previous?.text ?? '') + (p.delta ?? '') }));
    } else if (event.type === 'part.upserted' || event.type === 'part.started') {
      const part = p.part ?? p;
      if (part.type === 'text' || part.type === 'reasoning') out.push(this.update(`${this.runId}:part:${part.id ?? p.partId}`, { kind: part.type === 'reasoning' ? 'reasoning' : 'assistant', text: part.text ?? part.reasoning ?? '' }));
    } else if (event.type === 'tool.updated') {
      if (!p.toolCallId) return [];
      const key = `${this.runId}:tool:${p.toolCallId}`;
      out.push(this.update(key, { kind: 'tool', ...(p.toolName ? { toolName: p.toolName } : {}), ...(p.input !== undefined ? { input: typeof p.input === 'string' ? p.input : JSON.stringify(p.input, null, 2) } : {}), ...(p.result !== undefined || p.output !== undefined ? { text: typeof (p.result ?? p.output) === 'string' ? p.result ?? p.output : JSON.stringify(p.result ?? p.output, null, 2) } : {}), status: ['failed','error'].includes(p.kind) ? 'error' : ['completed', 'finished','result'].includes(p.kind) ? 'done' : 'running' }));
    } else if (event.type === 'turn.failed') out.push(this.update(`${this.runId}:error`, { kind: 'error', text: p.error?.message ?? p.message ?? JSON.stringify(p) }));
    return out;
  }
}
