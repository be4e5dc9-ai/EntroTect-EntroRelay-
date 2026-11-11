import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AgentClient } from './agent-client';
import { codexHistoryItems, portableMessages, portableText, type PortableEntry, type PortableMessage, type PortableTool } from './portable-history';
import { atomicFile } from './store';

function responseMessage(item: any, time: number): PortableMessage | undefined {
  if (item?.type !== 'message' || !['user', 'assistant'].includes(item.role) || !Array.isArray(item.content)) return;
  const text = item.content.flatMap((block: any) => ['input_text', 'output_text', 'text'].includes(block?.type) && typeof block.text === 'string' ? [block.text] : []).join('\n');
  if (!text.trim() || (item.role === 'user' && /^\s*<(environment_context|user_instructions)>[\s\S]*<\/\1>\s*$/.test(text))) return;
  return { role: item.role, text, time };
}

function readResponseItem(entries: PortableEntry[], calls: Map<string, PortableTool>, item: any, time: number) {
  const message = responseMessage(item, time);
  if (message) { entries.push(message); return; }
  if (['function_call', 'custom_tool_call'].includes(item?.type) && typeof item.call_id === 'string' && typeof item.name === 'string') {
    const tool: PortableTool = { kind: 'tool', callId: item.call_id, name: item.name, arguments: portableText(item.arguments ?? item.input), time };
    calls.set(tool.callId, tool);
    entries.push(tool);
  } else if (['function_call_output', 'custom_tool_call_output'].includes(item?.type)) {
    const tool = calls.get(item.call_id);
    if (tool && item.output != null) { tool.output = portableText(item.output); tool.endedAt = time; }
  } else if (item?.type === 'reasoning') {
    const summary = Array.isArray(item.summary) ? portableText(item.summary) : '';
    if (summary.trim()) entries.push({ kind: 'reasoning', text: summary, time });
  }
}

export async function readCodexHistory(client: AgentClient, home: string, id: string) {
  const { thread } = await client.rpc.request('thread/read', { threadId: id }, 15_000);
  if (thread?.id !== id || typeof thread.path !== 'string' || !path.isAbsolute(thread.path)) throw new Error('Codex 尚未保存此会话');
  const [root, file] = await Promise.all([realpath(home), realpath(thread.path)]);
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || path.extname(file) !== '.jsonl') {
    throw new Error('Codex 返回了会话目录以外的路径');
  }
  const raw = await readFile(file, 'utf8');
  const history: PortableEntry[] = [];
  const archivedCalls = new Map<string, PortableTool>(), retainedCalls = new Map<string, PortableTool>();
  let retained: PortableEntry[] = [];
  let hasUserEvent = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const time = Date.parse(row.timestamp) || 0;
    if (row.type === 'event_msg') {
      const event = row.payload;
      if (event?.type === 'user_message' || event?.type === 'item_completed' && event.item?.type === 'UserMessage') {
        hasUserEvent = true;
      }
    } else if (row.type === 'response_item') {
      readResponseItem(history, archivedCalls, row.payload, time);
      readResponseItem(retained, retainedCalls, row.payload, time);
    } else if (row.type === 'compacted') {
      if (Array.isArray(row.payload?.replacement_history)) {
        retained = [];
        retainedCalls.clear();
        for (const item of row.payload.replacement_history) readResponseItem(retained, retainedCalls, item, time);
      } else if (typeof row.payload?.message === 'string' && row.payload.message.trim()) {
        retainedCalls.clear();
        retained = [{ role: 'assistant', text: `之前的会话摘要\n${row.payload.message}`, time }];
      }
    }
  }
  const listed = hasUserEvent && relative.startsWith(`sessions${path.sep}`);
  return { thread, file, version: createHash('sha256').update(raw).digest('hex'), history, retained, archived: portableMessages(history), resume: portableMessages(retained), busy: thread.status?.type === 'active', listed };
}

export async function writeCodexHistory(client: AgentClient, cwd: string, title: string, messages: readonly PortableEntry[]) {
  if (!messages.length) throw new Error('没有可导入 Codex 的上下文');
  const session = await client.open(cwd);
  await client.inject(session.id, codexHistoryItems(messages));
  await client.rpc.request('thread/name/set', { threadId: session.id, name: title }, 15_000);
  return session;
}

export async function publishCodexHistory(home: string, native: Awaited<ReturnType<typeof readCodexHistory>>, id: string) {
  const first = native.archived.find(message => message.role === 'user');
  if (!first) throw new Error('Codex 历史需要一条用户消息才能显示在原生列表中');
  const raw = await readFile(native.file, 'utf8');
  if (createHash('sha256').update(raw).digest('hex') !== native.version) throw new Error('Codex 会话在发布前已更新');
  const lines = raw.trimEnd().split(/\r?\n/);
  const rows = lines.map(line => JSON.parse(line));
  const isInjectionRecord = (row: any) => ['response_item', 'world_state', 'turn_context'].includes(row.type) || row.type === 'event_msg' && row.payload?.type === 'thread_settings_applied';
  if (rows[0]?.type !== 'session_meta' || rows[0]?.payload?.id !== id || !rows.slice(1).every(isInjectionRecord)) {
    throw new Error('Codex 导入会话的原生格式已变化，已停止发布索引');
  }
  // inject_items only writes model-visible items. The workspace picker
  // requires a user event, and the global picker reads its SQLite projection.
  lines.splice(1, 0, JSON.stringify({ timestamp: rows[0].timestamp, type: 'event_msg', payload: { type: 'user_message', message: first.text, images: [], local_images: [], text_elements: [] } }));
  await atomicFile(native.file, lines.join('\n') + '\n', raw);
  await indexNewCodexThread(home, native.file, id, first.text);
}

async function indexNewCodexThread(home: string, rollout: string, id: string, message: string) {
  const { DatabaseSync } = await import('node:sqlite');
  const databases = (await readdir(home)).filter(name => /^state_\d+\.sqlite$/.test(name));
  for (const file of databases) {
    const database = path.join(home, file);
    if (path.dirname(await realpath(database)).toLowerCase() !== (await realpath(home)).toLowerCase()) continue;
    const db = new DatabaseSync(database, { timeout: 3_000 });
    try {
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
      if (!['id', 'rollout_path', 'archived', 'has_user_event', 'first_user_message', 'preview'].every(column => columns.has(column))) continue;
      const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ? AND archived = 0').get(id);
      if (typeof row?.rollout_path !== 'string' || path.resolve(row.rollout_path).toLowerCase() !== path.resolve(rollout).toLowerCase()) continue;
      db.prepare(`UPDATE threads SET has_user_event = 1, first_user_message = ?, preview = CASE WHEN COALESCE(preview, '') = '' THEN ? ELSE preview END
        WHERE id = ? AND rollout_path = ? AND archived = 0 AND has_user_event = 0 AND COALESCE(first_user_message, '') = ''`)
        .run(message.slice(0, 4096), message.trim().slice(0, 256), id, row.rollout_path);
      return;
    } finally { db.close(); }
  }
}
