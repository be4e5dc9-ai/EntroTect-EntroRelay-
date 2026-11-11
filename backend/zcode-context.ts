import { completedEntries, portableText, toolArguments, type PortableEntry } from './portable-history';
import { nativeSqlite } from './native-sqlite';

type StoredMessage = { id: string; time: number; data: string };
type StoredPart = { messageId: string; data: string };
type NativeMessage = { id: string; time: number; info: any; parts: any[] };
const scaffolding = new Set(['system_reminder', 'system-prompt', 'runtime-context', 'skill-catalog', 'time-context', 'timeline_event', 'context-import']);

function toEntries(message: NativeMessage): PortableEntry[] {
  const { info, parts, time } = message;
  if (scaffolding.has(info.semantics?.kind) || !['user', 'assistant'].includes(info.role)) return [];
  const entries: PortableEntry[] = [];
  for (const part of parts) {
    const at = part.time?.start ?? time;
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      entries.push({ role: info.role, text: part.text, time: at });
    } else if (part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) {
      entries.push({ kind: 'reasoning', text: part.text, time: at });
    } else if (part.type === 'tool' && typeof part.callID === 'string' && typeof part.tool === 'string') {
      const state = part.state ?? {};
      entries.push({ kind: 'tool', callId: part.callID, name: part.tool, arguments: portableText(state.input ?? {}),
        output: ['completed', 'error'].includes(state.status) ? portableText(state.output ?? state.error) : undefined,
        time: state.time?.start ?? time, endedAt: state.time?.end });
    }
  }
  return entries;
}

export async function readZCodeContext(node: string, source: string, sessionId: string) {
  const data = await nativeSqlite<{ messages: StoredMessage[]; parts: StoredPart[] }>(node, { action: 'readContext', source, sessionId });
  const messages = new Map<string, NativeMessage>();
  for (const row of data.messages) messages.set(row.id, { id: row.id, time: row.time, info: JSON.parse(row.data), parts: [] });
  for (const row of data.parts) messages.get(row.messageId)?.parts.push(JSON.parse(row.data));
  const ordered = [...messages.values()];
  const visible = (message: NativeMessage) => message.info.semantics?.providerVisibility !== 'hidden';
  const summary = (message: NativeMessage) => message.info.summary === true || ['compact_summary', 'compact-summary'].includes(message.info.semantics?.kind);
  const history = ordered.filter(message => !message.info.entrotectResume && !summary(message)).flatMap(toEntries);
  const latest = ordered.map((message, index) => ({
    index, marker: [...message.parts].reverse().find(part => part.type === 'compaction' &&
      (!part.timelineStatus || part.compactBoundary?.summaryMessageIds?.includes(message.id))),
  })).reverse().find(entry => entry.marker);
  if (!latest) return { history, retained: ordered.filter(visible).flatMap(toEntries) };

  const { index: at, marker } = latest;
  const boundary = marker.compactBoundary;
  const summaryIds = new Set<string>(Array.isArray(boundary?.summaryMessageIds) ? boundary.summaryMessageIds : []);
  let following = at + 1;
  const retained: PortableEntry[] = [];
  if (!marker.harnessBridgeResume && !ordered[at].info.entrotectCheckpoint) {
    const inline = typeof marker.summary === 'string' && marker.summary.trim() ? marker.summary : undefined;
    if (!summaryIds.size && marker.summaryMessageId) summaryIds.add(marker.summaryMessageId);
    if (!summaryIds.size && !inline) {
      const i = ordered.findIndex((message, index) => index >= following && summary(message));
      if (i >= 0) { summaryIds.add(ordered[i].id); following = i + 1; }
    }
    const text = inline ?? ordered.filter(message => summaryIds.has(message.id)).flatMap(message => message.parts)
        .filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
    if (!text.trim()) throw new Error('ZCode 压缩边界缺少已保存的摘要');
    retained.push({ role: 'assistant', text: `之前的会话摘要\n${text}`, time: ordered[at].time });
  }
  const tailId = boundary?.preservedSegment?.headMessageId ?? (!boundary || boundary.keptMessageCount > 0 ? marker.tail_start_id : undefined);
  const tail = ordered.findIndex(message => message.id === tailId);
  const tailEnd = ordered.findIndex(message => message.id === boundary?.preservedSegment?.tailMessageId);
  for (const [index, message] of ordered.entries()) {
    if ((index >= following || tail >= 0 && index >= tail && index <= (tailEnd >= tail ? tailEnd : at)) &&
        visible(message) && !summaryIds.has(message.id)) retained.push(...toEntries(message));
  }
  return { history, retained };
}

export function zcodeContextMessages(context: { archive: readonly PortableEntry[]; retained: readonly PortableEntry[]; separate: boolean }) {
  function encode(entries: readonly PortableEntry[], view: 'both' | 'archive' | 'resume') {
    const tools = new Set(completedEntries(entries));
    return entries.flatMap(entry => {
      const role = 'role' in entry ? entry.role : 'assistant';
      const info = {
        role, ...(view === 'resume' && { entrotectResume: true }),
        ...(role === 'assistant' && { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
        semantics: {
          origin: role === 'user' ? 'real_user' : 'agent_runtime',
          kind: role === 'user' ? 'user_prompt' : 'assistant_response',
          uiVisibility: view === 'resume' ? 'hidden' : 'visible',
          transcriptVisibility: view === 'resume' ? 'hidden' : 'visible',
          providerVisibility: view === 'archive' ? 'hidden' : 'visible',
        },
      };
      const time = { start: entry.time, end: entry.time };
      if ('role' in entry) return [{ time: entry.time, info, parts: [{ type: 'text', text: entry.text, time }] as object[] }];
      if (entry.kind === 'reasoning') return [{ time: entry.time, info, parts: [{ type: 'reasoning', text: entry.text, time }] as object[] }];
      if (!tools.has(entry)) return [];
      return [{ time: entry.time, info, parts: [{
        type: 'tool', callID: entry.callId, tool: entry.name,
        state: { status: 'completed', input: toolArguments(entry.arguments), output: entry.output, time: { start: entry.time, end: entry.endedAt ?? entry.time } },
      }] as object[] }];
    });
  }
  if (!context.separate) return encode(context.retained, 'both');
  const archive = encode(context.archive, 'archive');
  if (!archive.length) return encode(context.retained, 'both');
  const checkpoint = {
    time: context.retained[0]?.time ?? 0,
    info: {
      role: 'user', entrotectCheckpoint: true,
      semantics: { origin: 'agent_runtime', kind: 'compact_summary', uiVisibility: 'hidden', transcriptVisibility: 'hidden', providerVisibility: 'visible' },
    },
    parts: [{ type: 'text', text: '以下是该会话保留的续聊上下文。' }],
  };
  return [...archive, checkpoint, ...encode(context.retained, 'resume')];
}
