import { createHash } from 'node:crypto';

export interface PortableMessage {
  role: 'user' | 'assistant';
  text: string;
  time: number;
}

export interface PortableTool {
  kind: 'tool';
  callId: string;
  name: string;
  arguments: string;
  output?: string;
  time: number;
  endedAt?: number;
}

export interface PortableReasoning { kind: 'reasoning'; text: string; time: number; }
export type PortableEntry = PortableMessage | PortableTool | PortableReasoning;

export function portableMessages(entries: readonly PortableEntry[]) {
  return entries.filter((entry): entry is PortableMessage => 'role' in entry);
}

export function portableText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (Array.isArray(value) && value.every(part => typeof part?.text === 'string')) return value.map(part => part.text).join('\n');
  return JSON.stringify(value);
}

export function toolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* Some native tools accept a raw string. */ }
  return { input: value };
}

export function completedEntries(entries: readonly PortableEntry[]) {
  const calls = new Set<string>();
  return entries.filter((entry): entry is PortableMessage | PortableTool => {
    if ('role' in entry) return true;
    if (entry.kind !== 'tool' || entry.output === undefined || calls.has(entry.callId)) return false;
    calls.add(entry.callId);
    return true;
  });
}

function toolValue(tool: PortableTool) {
  return [tool.callId, tool.name, sorted(toolArguments(tool.arguments)), tool.output];
}

export function portableHistoryFingerprint(entries: readonly PortableEntry[]) {
  const messages = portableMessages(entries).map(({ role, text }) => [role, text]);
  const tools = completedEntries(entries).flatMap(entry => 'kind' in entry ? [JSON.stringify(toolValue(entry))] : []).sort();
  return createHash('sha256').update(JSON.stringify({ messages, tools })).digest('hex');
}

export function nativeContentFingerprint(native: { history: readonly PortableEntry[]; retained?: readonly PortableEntry[] }) {
  const project = (entries: readonly PortableEntry[]) => entries.map(entry => {
    if ('role' in entry) return [entry.role, entry.text];
    if (entry.kind === 'reasoning') return [entry.kind, entry.text];
    return [entry.kind, ...toolValue(entry)];
  });
  return createHash('sha256').update(JSON.stringify([project(native.history), native.retained && project(native.retained)])).digest('hex');
}

export function unpublishedMessages(published: readonly PortableMessage[], current: readonly PortableMessage[]) {
  if (published.length > current.length || published.some((message, i) => message.role !== current[i].role || message.text !== current[i].text)) {
    throw new Error('两端对话的已有内容不同，无法追加到原会话');
  }
  return current.slice(published.length);
}

export function unpublishedEntries(published: readonly PortableEntry[], current: readonly PortableEntry[]) {
  const previous = portableMessages(published);
  unpublishedMessages(previous, portableMessages(current));
  let cursor = 0, seen = 0;
  while (seen < previous.length) if ('role' in current[cursor++]) seen++;
  const calls = new Map(completedEntries(published).flatMap(entry => 'kind' in entry ? [[entry.callId, entry] as const] : []));
  return completedEntries(current.slice(cursor)).filter(entry => {
    if ('role' in entry) return true;
    const existing = calls.get(entry.callId);
    if (!existing) return true;
    if (JSON.stringify(toolValue(existing)) !== JSON.stringify(toolValue(entry))) {
      throw new Error('原生会话中的已有工具记录不同，无法重复追加');
    }
    return false;
  });
}

export type BridgeEvent = { time_ms?: number; kind: string | {
  Message?: { role?: string; text?: string; source_kind?: string | null };
  ToolCall?: { call_id?: string; name?: string; arguments?: string };
  ToolResult?: { call_id?: string; text?: string };
  Reasoning?: { text?: string };
  TurnEnd?: { reason: string };
} };

export interface BridgeHistory {
  payload: { root_session_id: string; sessions: {
    id: string; created_ms?: number; events: BridgeEvent[]; resume_events?: BridgeEvent[] | null;
  }[] };
}

const nativeOnly = new Set(['system_reminder', 'system-prompt', 'runtime-context', 'skill-catalog', 'time-context', 'timeline_event', 'context-import']);
const summaries = new Set(['compact_summary', 'compact-summary']);
export const contextSuffix = '.entrotect.json';

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sorted(item)]));
  return value;
}

export function bridgePayloadChecksum(payload: unknown) {
  return createHash('sha256').update(JSON.stringify(sorted(payload))).digest('hex');
}

export function bridgeEntries(history: BridgeHistory, view: 'resume' | 'archive' = 'resume'): PortableEntry[] {
  const session = history.payload.sessions.find(entry => entry.id === history.payload.root_session_id);
  if (!session) throw new Error('统一上下文缺少主会话');
  const events = view === 'resume' ? session.resume_events ?? session.events : session.events;
  const entries: PortableEntry[] = [];
  const tools = new Map<string, PortableTool>();
  for (const event of events) {
    if (typeof event.kind !== 'object' || event.kind === null) continue;
    const { Message: message, ToolCall: call, ToolResult: result, Reasoning: reasoning } = event.kind;
    const time = event.time_ms || session.created_ms || 0;
    const source = message?.source_kind ?? '';
    if (typeof message?.text === 'string' && message.text.trim() && !nativeOnly.has(source)) {
      if (summaries.has(source)) entries.push({ role: 'assistant', text: `之前的会话摘要\n${message.text}`, time });
      else if (message.role === 'User' || source === 'user_prompt') entries.push({ role: 'user', text: message.text, time });
      else if (message.role === 'Assistant') entries.push({ role: 'assistant', text: message.text, time });
    }
    if (call?.call_id && call.name) {
      const entry: PortableTool = { kind: 'tool', callId: call.call_id, name: call.name, arguments: call.arguments ?? '{}', time };
      tools.set(entry.callId, entry);
      entries.push(entry);
    }
    if (result?.call_id && typeof result.text === 'string') {
      const tool = tools.get(result.call_id);
      if (tool) { tool.output = result.text; tool.endedAt = time; }
    }
    if (reasoning?.text?.trim()) entries.push({ kind: 'reasoning', text: reasoning.text, time });
  }
  return entries;
}

export function bridgeMessages(history: BridgeHistory, view: 'resume' | 'archive' = 'resume'): PortableMessage[] {
  return portableMessages(bridgeEntries(history, view));
}

export function bundledContext(history: BridgeHistory) {
  const archive = bridgeEntries(history, 'archive');
  const effective = bridgeEntries(history, 'resume');
  const allowed = new Set(completedEntries(effective));
  const resume = effective.filter(entry => 'kind' in entry && entry.kind === 'reasoning' || allowed.has(entry as PortableMessage | PortableTool));
  const size = (entries: readonly PortableEntry[]) => entries.reduce((total, entry) => total + ('text' in entry
    ? entry.text.length : entry.name.length + entry.arguments.length + (entry.output?.length ?? 0)), 0);
  const budget = 750_000;
  const shorten = (value: string) => value.length > 8_000 ? value.slice(0, 5_500) + '\n[EntroTect 已缩短历史输出]\n' + value.slice(-2_400) : value;
  const retained = size(resume) <= budget ? resume : resume.map(entry => {
    if ('role' in entry) return entry;
    if (entry.kind === 'reasoning') return { ...entry, text: shorten(entry.text) };
    const args = shorten(entry.arguments);
    return { ...entry, arguments: args === entry.arguments ? args : JSON.stringify({ shortened: args }), output: entry.output === undefined ? undefined : shorten(entry.output) };
  });
  if (size(retained) > budget) throw new Error('续聊上下文超过目标 Harness 的安全上限。请先在当前会话压缩上下文，再切换。');
  return { archive, retained, separate: JSON.stringify(archive) !== JSON.stringify(retained) };
}

export function codexHistoryItems(entries: readonly PortableEntry[]): unknown[] {
  const items: unknown[] = [];
  for (const entry of completedEntries(entries)) {
    if ('role' in entry) items.push({ type: 'message', role: entry.role, content: [{ type: entry.role === 'user' ? 'input_text' : 'output_text', text: entry.text }] });
    else items.push({ type: 'function_call', call_id: entry.callId, name: entry.name, arguments: JSON.stringify(toolArguments(entry.arguments)) },
      { type: 'function_call_output', call_id: entry.callId, output: entry.output });
  }
  return items;
}

function bridgeEvents(entries: readonly PortableEntry[], createdAt: number) {
  const events: BridgeEvent[] = [];
  let open = false;
  let last = createdAt;
  for (const entry of entries) {
    const { time } = entry;
    if ('text' in entry && !entry.text.trim()) continue;
    if ('role' in entry && entry.role === 'user' || !open) {
      if (open) events.push({ time_ms: last, kind: { TurnEnd: { reason: 'completed' } } });
      events.push({ time_ms: time, kind: 'TurnStart' });
      open = true;
    }
    if ('role' in entry) events.push({ time_ms: time, kind: { Message: { role: entry.role === 'user' ? 'User' : 'Assistant', text: entry.text, source_kind: entry.role === 'user' ? 'user' : null } } });
    else if (entry.kind === 'reasoning') events.push({ time_ms: time, kind: { Reasoning: { text: entry.text } } });
    else {
      events.push({ time_ms: time, kind: { ToolCall: { call_id: entry.callId, name: entry.name, arguments: entry.arguments } } });
      if (entry.output !== undefined) events.push({ time_ms: entry.endedAt ?? time, kind: { ToolResult: { call_id: entry.callId, text: entry.output } } });
    }
    last = 'kind' in entry && entry.kind === 'tool' ? entry.endedAt ?? time : time;
  }
  if (open) events.push({ time_ms: last, kind: { TurnEnd: { reason: 'completed' } } });
  return events;
}

export function messagesToBridge(messages: readonly PortableEntry[], session: { id: string; title: string; cwd: string; createdAt: number; updatedAt: number; source?: string }, resume?: readonly PortableEntry[]) {
  const events = bridgeEvents(messages, session.createdAt);
  const payload = { root_session_id: session.id, sessions: [{
    source: session.source ?? 'codex', id: session.id, title: session.title, cwd: session.cwd,
    agent_preset: null, parent_session: null, origin: null,
    created_ms: session.createdAt, updated_ms: session.updatedAt, events, resume_events: resume ? bridgeEvents(resume, session.createdAt) : events,
  }] };
  return { format: 'entrotect-context', version: 1, exported_at: new Date().toISOString(), sha256: bridgePayloadChecksum(payload), payload };
}
