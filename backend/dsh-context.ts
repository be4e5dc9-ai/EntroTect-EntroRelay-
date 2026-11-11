import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deepSeekLog, deepSeekTranscript, dshProjectKey } from './dsh-files';
import { completedEntries, portableText, type PortableEntry, type PortableTool } from './portable-history';
import { textBlocks } from './projection';

const seedStart = 'plugin:entrotect/resume-start';
const seedEnd = 'plugin:entrotect/resume-end';

export function deepSeekArchive(rows: readonly any[]) {
  let seed = false;
  return rows.filter(row => {
    if (row.type === seedStart) { seed = true; return false; }
    if (row.type === seedEnd) { seed = false; return false; }
    return !seed;
  });
}

function entries(rows: readonly any[], resume: boolean, createdAt: number) {
  const history: PortableEntry[] = [];
  const tools = new Map<string, PortableTool>();
  function call(id: unknown, name: unknown, args: unknown, time: number) {
    if (typeof id !== 'string' || typeof name !== 'string' || tools.has(id)) return;
    const item: PortableTool = { kind: 'tool', callId: id, name, arguments: portableText(args ?? {}), time };
    tools.set(id, item); history.push(item);
  }
  function user(message: any, time: number) {
    const text = textBlocks(message.content);
    if (!text.trim()) return;
    const source = message.source?.kind;
    if (!source || source === 'user' || source === 'user-approval' || source === 'user_prompt') history.push({ role: 'user', text, time });
    else if (resume && source === 'compact-checkpoint' && !text.startsWith('The retained migration context follows')) {
      history.push({ role: 'assistant', text, time });
    }
  }
  const userIds = new Set(rows.filter(row => row.type === 'user/message').map(row => (row.data?.message ?? row.data)?.id).filter(Boolean));
  for (const row of rows) {
    const time = row.time ?? createdAt, data = row.data ?? {}, message = data.message ?? data;
    switch (row.type) {
      case 'user/message': user(message, time); break;
      case 'agent/inbox/spliced':
        if (!resume) for (const inserted of data.inserted ?? []) if (!userIds.has(inserted.id)) user(inserted, time);
        break;
      case 'assistant/message': {
        const content = Array.isArray(message.content) ? message.content : [];
        const thought = content.filter((block: any) => block.type === 'reasoning' && typeof block.text === 'string').map((block: any) => block.text).join('\n');
        if (thought.trim()) history.push({ kind: 'reasoning', text: thought, time });
        const text = textBlocks(message.content);
        if (text.trim()) history.push({ role: 'assistant', text, time });
        for (const block of content) if (block.type === 'tool-call') call(block.id, block.name, block.arguments, time);
        break;
      }
      case 'tool/call': call(data.callId, data.name, data.arguments, time); break;
      case 'tool/result': {
        const item = tools.get(message.toolCallId ?? message.callId);
        if (!item) break;
        const text = textBlocks(message.content);
        item.output = item.output ? [item.output, text].filter(Boolean).join('\n') : text;
        item.endedAt = time;
        break;
      }
    }
  }
  return history;
}

export async function readDeepSeekContext(home: string, workspace: string, id: string, createdAt: number) {
  if (!/^[\w-]{1,128}$/.test(id)) throw new Error('DeepSeek 会话 ID 无效');
  const file = await deepSeekLog(path.join(home, 'sessions', dshProjectKey(workspace), id));
  if (!file) throw new Error('找不到 DeepSeek 原生会话');
  const [header, ...rows] = await deepSeekTranscript(file);
  if (header?.type !== 'session' || header.id !== id) throw new Error('DeepSeek 原生日志头无效');
  const history = entries(deepSeekArchive(rows), false, header.createdAt ?? createdAt);
  const surface: any[] = [];
  for (const row of rows) {
    const operation = row.surfaceOp;
    if (operation === 'append') surface.push(row);
    else if (operation?.op === 'replace') {
      const start = surface.findIndex(event => event.seq === operation.startSeq);
      const end = surface.findIndex(event => event.seq === operation.endSeq);
      if (start < 0 || end < start) throw new Error('DeepSeek 压缩后的上下文范围不完整');
      surface.splice(start, end - start + 1, row);
    } else if (operation != null) throw new Error('不支持的 DeepSeek 上下文操作');
  }
  if (!surface.length && rows.some(row => row.type === 'compaction/summary')) throw new Error('DeepSeek 压缩日志缺少可恢复的上下文');
  return { history, retained: surface.length ? entries(surface, true, header.createdAt ?? createdAt) : history };
}

export async function writeDeepSeekContext(home: string, workspace: string, source: string, createdAt: number,
  context: { archive: readonly PortableEntry[]; retained: readonly PortableEntry[]; separate: boolean }) {
  const id = randomUUID();
  const directory = path.join(home, 'sessions', dshProjectKey(workspace), id);
  const header = { type: 'session', version: 4, id, cwd: workspace, createdAt, isSeeded: false, delegationDepth: 0 };
  const rows: Record<string, unknown>[] = [];
  const step = { turn: 1, step: 1 };
  let endTime = createdAt;
  function add(type: string, data: object, time: number, options: object = {}) {
    const seq = rows.length;
    rows.push({ type, seq, time, data, ...options });
    endTime = Math.max(endTime, time);
    return seq;
  }
  const append = { surfaceOp: 'append' };
  const block = (text: string) => ({ type: 'text', text });
  const user = (text: string, kind = 'user') => ({ id: randomUUID(), role: 'user', source: { kind }, content: [block(text)] });
  function assistant(content: object[], time: number) {
    return add('assistant/message', {
      ...step,
      message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: `imported:${source}`, model: 'unknown' }, content },
      stream: [
        ...content.flatMap((item, index) => [
          { type: 'chunk', time, chunk: { type: 'block-start', index, blockType: (item as { type: string }).type } },
          { type: 'chunk', time, chunk: { type: 'block-end', index, block: item } },
        ]),
        { type: 'chunk', time, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ],
    }, time, append);
  }
  const archived: number[] = [];
  function write(list: readonly PortableEntry[], surface: number[]) {
    const tools = new Set(completedEntries(list));
    let reasoning: { type: 'reasoning'; text: string }[] = [];
    for (const entry of list) {
      const time = entry.time || createdAt;
      if ('role' in entry) {
        if (entry.role === 'user') {
          if (reasoning.length) surface.push(assistant(reasoning, time));
          surface.push(add('user/message', user(entry.text), time, append));
        } else surface.push(assistant([...reasoning, block(entry.text)], time));
        reasoning = [];
      } else if (entry.kind === 'reasoning') reasoning.push({ type: 'reasoning', text: entry.text });
      else if (tools.has(entry)) {
        const { callId, name, arguments: args } = entry;
        surface.push(assistant([...reasoning, { type: 'tool-call', id: callId, name, arguments: args }], time));
        reasoning = [];
        add('tool/call', { ...step, callId, name, arguments: args }, time);
        surface.push(add('tool/result', { ...step, message: {
          id: randomUUID(), role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
          isError: false, content: [block(entry.output!)],
        } }, entry.endedAt || time, append));
      }
    }
    if (reasoning.length) surface.push(assistant(reasoning, endTime));
  }
  add('turn/start', { turn: 1 }, createdAt);
  add('step/start', step, createdAt);
  add('system/message', { ...step, message: { id: randomUUID(), role: 'system', content: [], source: { kind: 'system-prompt' } } }, createdAt, append);
  write(context.archive, archived);
  if (context.separate) {
    add(seedStart, {}, endTime, { ignorable: true });
    const checkpoint = archived.length ? {
      surfaceOp: { op: 'replace', startSeq: archived[0], endSeq: archived.at(-1) }, sourceEventSeqs: archived,
    } : append;
    add('user/message', user('以下是当前对话保留的上下文。', 'context-import'), endTime, checkpoint);
    write(context.retained, []);
    add(seedEnd, {}, endTime, { ignorable: true });
  }
  add('step/end', step, endTime);
  add('turn/end', { turn: 1, reason: { kind: 'completed' } }, endTime);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'session.v4.jsonl'), [header, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' });
  return id;
}
