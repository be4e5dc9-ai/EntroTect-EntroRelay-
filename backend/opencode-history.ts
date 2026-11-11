import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { completedEntries, portableMessages, portableText, toolArguments, unpublishedEntries, type PortableEntry } from './portable-history';
import type { DatabaseSync } from 'node:sqlite';
import { sumReportedTokens, type NativeTokenReport } from './token-activity';

const execute = promisify(execFile);
const verifiedOpenCodeStorage = '1.19.5';
type NativeCli = { executable: string; prefix?: string[]; env: NodeJS.ProcessEnv };
type OpenCodeModel = { providerID: string; modelID: string; variant?: string };

async function run(cli: NativeCli, cwd: string, args: string[]) {
  return execute(cli.executable, [...(cli.prefix ?? []), '--pure', ...args], { cwd, env: cli.env, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 ** 2 });
}

function id(kind: 'ses' | 'msg' | 'prt', time: number) {
  const stamp = BigInt(time) * 4096n;
  const encoded = BigInt.asUintN(48, kind === 'ses' ? ~stamp : stamp).toString(16).padStart(12, '0');
  return `${kind}_${encoded}${randomBytes(7).toString('hex')}`;
}

export async function readOpenCodeHistory(cli: NativeCli, cwd: string, sessionId: string) {
  if (!/^ses[\w-]+$/.test(sessionId)) throw new Error('OpenCode 会话 ID 无效');
  const { stdout } = await run(cli, cwd, ['export', sessionId]);
  const history = JSON.parse(stdout);
  if (history?.info?.id !== sessionId || !Array.isArray(history.messages)) throw new Error('OpenCode 返回了无效的会话导出');
  const entries = historyEntries(history.messages, history.info.time?.created);
  return { info: history.info, history: entries, archived: portableMessages(entries), version: createHash('sha256').update(stdout).digest('hex') };
}

function historyEntries(entries: any[], createdAt = 0) {
  const history: PortableEntry[] = [];
  for (const entry of entries) {
    if (!['user', 'assistant'].includes(entry.info?.role) || !Array.isArray(entry.parts)) continue;
    const at = entry.info.time?.created ?? createdAt;
    const texts = entry.parts.filter((part: any) => part.type === 'text' && !part.ignored && !part.synthetic && typeof part.text === 'string');
    for (const part of entry.parts) {
      if (part === texts[0]) {
        const text = texts.map((item: any) => item.text).join('\n');
        if (text.trim()) history.push({ role: entry.info.role, text, time: at });
      }
      if (part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) history.push({ kind: 'reasoning', text: part.text, time: part.time?.start ?? at });
      if (part.type === 'tool' && typeof part.callID === 'string' && typeof part.tool === 'string') {
        const state = part.state;
        const output = state?.status === 'completed' ? portableText(state.output) : state?.status === 'error' ? portableText(state.error) : undefined;
        history.push({ kind: 'tool', callId: part.callID, name: part.tool, arguments: portableText(state?.input ?? {}), output, time: state?.time?.start ?? at, endedAt: state?.time?.end });
      }
    }
  }
  return history;
}

function messageRows(sessionID: string, cwd: string, entries: readonly PortableEntry[], model: OpenCodeModel, start: number, lastUserId = '', syntheticFirst = false) {
  let parentID = lastUserId;
  return completedEntries(entries).map((entry, index) => {
    const role = 'role' in entry ? entry.role : 'assistant';
    const ordered = start + index;
    const messageID = id('msg', ordered);
    const created = Number.isSafeInteger(entry.time) && entry.time > 0 ? entry.time : ordered;
    const base = { id: messageID, sessionID, role, agent: 'build' };
    if (role === 'user') parentID = messageID;
    const info = role === 'user' ? { ...base, time: { created }, model } : {
      ...base, parentID, time: { created, completed: created }, mode: 'build', providerID: model.providerID, modelID: model.modelID,
      path: { cwd, root: cwd }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'stop',
    };
    const part = 'role' in entry
      ? { type: 'text', text: entry.text, ...(syntheticFirst && index === 0 ? { synthetic: true } : {}) }
      : { type: 'tool', tool: entry.name, callID: entry.callId, state: {
        status: 'completed', input: toolArguments(entry.arguments), output: entry.output, title: entry.name, metadata: {},
        time: { start: created, end: Math.max(created, entry.endedAt ?? created) },
      } };
    return { info, parts: [{ id: id('prt', ordered), sessionID, messageID, ...part }] };
  });
}

export async function writeOpenCodeHistory(cli: NativeCli, cwd: string, title: string, entries: readonly PortableEntry[], model: OpenCodeModel) {
  if (!path.isAbsolute(cwd) || !entries.length) throw new Error('OpenCode 工作目录或上下文无效');
  const now = Date.now();
  const sessionID = id('ses', now);
  const entriesToWrite = completedEntries(entries);
  const first = entriesToWrite[0];
  const synthetic = !!first && (!('role' in first) || first.role !== 'user');
  const source: readonly PortableEntry[] = synthetic ? [{ role: 'user', text: '以下是此前对话保留下来的上下文。', time: first.time }, ...entriesToWrite] : entriesToWrite;
  const rows = messageRows(sessionID, cwd, source, model, now - source.length - 1000, undefined, synthetic);
  const info = { id: sessionID, slug: sessionID, projectID: 'global', directory: cwd, title, version: verifiedOpenCodeStorage, time: { created: now, updated: now } };
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'entrotect-opencode-import-'));
  try {
    const file = path.join(scratch, 'session.json');
    await writeFile(file, JSON.stringify({ info, messages: rows }), { flag: 'wx' });
    const { stdout } = await run(cli, cwd, ['import', file]);
    if (!stdout.includes(`Imported session: ${sessionID}`)) throw new Error('OpenCode 没有确认导入会话');
    return sessionID;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

function storageRows(db: DatabaseSync, sessionId: string) {
  const session = db.prepare('SELECT * FROM session WHERE id = ?').get(sessionId);
  if (!session) throw new Error('OpenCode 原生会话不存在');
  const messages = db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id').all(sessionId);
  const parts = db.prepare('SELECT * FROM part WHERE session_id = ? ORDER BY id').all(sessionId);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_message'").get()
    && db.prepare('SELECT 1 FROM session_message WHERE session_id = ? LIMIT 1').get(sessionId)) throw new Error('此 OpenCode 会话使用了更新的历史存储格式');
  const partsByMessage = new Map<unknown, any[]>();
  const tokenReports: NativeTokenReport[] = [];
  for (const row of parts) {
    const part = JSON.parse(String(row.data));
    if (part.type === 'step-finish' && typeof row.id === 'string') {
      const tokens = part.tokens;
      const total = sumReportedTokens([tokens?.total]) ??
        sumReportedTokens([tokens?.input, tokens?.output], [tokens?.reasoning, tokens?.cache?.read, tokens?.cache?.write]);
      if (total) tokenReports.push({ id: row.id, tokens: total, time: Number(row.time_created) });
    }
    const list = partsByMessage.get(row.message_id) ?? [];
    list.push(part);
    partsByMessage.set(row.message_id, list);
  }
  const records = messages.map(row => ({ info: { ...JSON.parse(String(row.data)), id: row.id }, parts: partsByMessage.get(row.id) ?? [] }));
  const history = historyEntries(records, Number(session.time_created));
  const busy = records.some(entry => entry.parts.some(part => part.type === 'tool' && ['pending', 'running'].includes(part.state?.status)));
  // OpenCode saves the user message before invoking its model. A tool-only
  // reply or a compacted summary can be followed by another native step.
  const lastUser = records.filter(entry => entry.info.role === 'user').at(-1)?.info;
  const lastReply = lastUser && records.filter(entry => entry.info.role === 'assistant' && entry.info.parentID === lastUser.id).at(-1)?.info;
  const openTurn = !!lastUser && (!lastReply?.time?.completed || !lastReply.finish && !lastReply.error ||
    !lastReply.error && (lastReply.finish === 'tool-calls' || lastReply.summary === true));
  return { history, archived: portableMessages(history), tokenReports, busy, openTurn,
    version: createHash('sha256').update(JSON.stringify({ session, messages, parts })).digest('hex'), records, session };
}

export async function openCodePartCursor(database: string, sessionId: string) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(database, { readOnly: true, timeout: 3_000 });
  try {
    const row = db.prepare('SELECT MAX(id) AS last FROM part WHERE session_id = ?').get(sessionId);
    return typeof row?.last === 'string' ? row.last : '';
  } finally { db.close(); }
}

export async function readOpenCodeStorage(database: string, sessionId: string) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(database, { readOnly: true, timeout: 3_000 });
  try { db.exec('BEGIN'); return storageRows(db, sessionId); }
  finally { db.close(); }
}

export async function appendOpenCodeHistory(database: string, cwd: string, sessionId: string, expected: string, current: readonly PortableEntry[], externalOpen = false) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(database, { timeout: 3_000 });
  try {
    db.exec('BEGIN IMMEDIATE');
    const native = storageRows(db, sessionId);
    if (native.version !== expected || native.busy) throw new Error('OpenCode 会话已更新或还未结束');
    if (externalOpen && native.session.version !== verifiedOpenCodeStorage) throw new Error('独立 OpenCode 正在运行，退出后将写回此版本的会话');
    if (externalOpen && native.openTurn) throw new Error('独立 OpenCode 的此会话正在运行，已暂缓写回');
    if (path.resolve(String(native.session.directory)).toLowerCase() !== path.resolve(cwd).toLowerCase()) throw new Error('OpenCode 会话已移动到其他项目');
    const delta = unpublishedEntries(native.history, current);
    if (delta.length) {
      const lastUser = native.records.filter(entry => entry.info.role === 'user').at(-1)?.info;
      const model = lastUser?.model;
      if (!model?.providerID || !model?.modelID) throw new Error('OpenCode 原生会话没有可复用的模型配置');
      const now = Date.now();
      const insertMessage = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
      const insertPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)');
      const rows = messageRows(sessionId, cwd, delta, model, now, lastUser.id);
      for (const [i, row] of rows.entries()) {
        const { id, sessionID: _, ...message } = row.info;
        insertMessage.run(id, sessionId, now + i, now + i, JSON.stringify(message));
        for (const { id: partId, messageID, sessionID: _session, ...part } of row.parts) insertPart.run(partId, messageID, sessionId, now + i, now + i, JSON.stringify(part));
      }
      db.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(now + rows.length, sessionId);
    }
    db.exec('COMMIT');
  } finally { db.close(); }
}
