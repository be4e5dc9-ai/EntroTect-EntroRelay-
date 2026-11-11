import { createHash, randomUUID } from 'node:crypto';
import { appendFile, link, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { completedEntries, portableMessages, portableText, toolArguments, type PortableEntry, type PortableTool } from './portable-history';
import { atomicFile, atomicJson } from './store';
import { sumReportedTokens, type NativeTokenReport } from './token-activity';

export interface KimiCheckpoint { text: string; afterTurn: number; }

// Kimi Code v2 groups sessions by its workspace key before the CLI looks up
// the session ID. Keep the on-disk boundary here and verify it against the CLI.
function bucket(cwd: string) {
  const normalized = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
  const name = (normalized.split('/').pop() ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  const slug = name && name !== '.' && name !== '..' ? name : 'workspace';
  return `wd_${slug}_${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

async function sessionFolder(home: string, cwd: string, id: string) {
  if (!/^[\w-]{1,120}$/.test(id)) throw new Error('Kimi Code 会话 ID 无效');
  const root = await realpath(home);
  const sessions = path.join(root, 'sessions');
  const implicit = bucket(cwd);
  const find = async (workspace: string) => {
    const candidate = path.join(sessions, workspace, id);
    const directory = await realpath(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (directory && path.relative(candidate, directory) !== '') throw new Error('Kimi Code 会话不在预期的历史目录中');
    return directory;
  };
  const direct = await find(implicit);
  if (direct) return direct;
  // Explicit Kimi workspaces have their own wm_ IDs. The CLI can also move
  // old implicit workspaces, so use the native directories as the fallback.
  const workspaces = (await readdir(sessions, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^(wm|wd)_[\w.-]+$/.test(entry.name) && entry.name !== implicit);
  const matches = (await Promise.all(workspaces.map(entry => find(entry.name)))).filter(directory => directory !== undefined);
  if (matches.length !== 1) throw new Error(matches.length ? 'Kimi Code 历史目录包含重复的会话 ID' : '找不到 Kimi Code 会话目录');
  return matches[0];
}

async function kimiStateFile(directory: string) {
  const primary = path.join(directory, 'state.json');
  try { await stat(primary); return primary; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return path.join(directory, 'session-meta', 'state.json');
}

async function readSessionFile(file: string) {
  for (let attempt = 0; ; attempt++) {
    try { return await readFile(file, 'utf8'); }
    catch (error) {
      if (attempt === 5 || !['ENOENT', 'EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await delay(25 * (attempt + 1));
    }
  }
}

export async function readKimiHistory(home: string, cwd: string, id: string) {
  const directory = await sessionFolder(home, cwd, id);
  const stateFile = await kimiStateFile(directory), wireFile = path.join(directory, 'agents', 'main', 'wire.jsonl');
  const [stateRaw, wireRaw] = await Promise.all([readSessionFile(stateFile), readSessionFile(wireFile)]);
  const state = JSON.parse(stateRaw);
  if (state.id !== id || state.version !== 2) throw new Error('Kimi Code 会话元数据版本不兼容');
  let time = state.createdAt;
  let turnId = -1, started = false;
  let prompt: string | undefined;
  let completedPrompt: { text: string; turnId: number } | undefined;
  const history: PortableEntry[] = [];
  const tokenReports: (NativeTokenReport & { turn: number })[] = [];
  const calls = new Map<string, PortableTool>();
  for (const line of wireRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    const step = record.type === 'context.append_loop_event' && record.agentId === 'main' ? record.event : undefined;
    const stepId = step?.stepUuid ?? step?.uuid;
    if (step?.type === 'step.end' && typeof stepId === 'string' && /^\d+$/.test(String(step.turnId))) {
      const usage = step.usage;
      const turn = Number(step.turnId);
      const tokens = sumReportedTokens([usage?.inputOther, usage?.output], [usage?.inputCacheRead, usage?.inputCacheCreation]);
      if (tokens && Number.isSafeInteger(turn)) tokenReports.push({ id: stepId, turn, tokens, time: record.time });
    }
    if (record.type === 'turn.prompt' && record.agentId === 'main') {
      started = true;
      if (Number.isFinite(record.time)) time = record.time;
      prompt = portableText(record.input);
    }
    if (Number.isSafeInteger(record.turnId)) turnId = Math.max(turnId, record.turnId);
    if (record.type === 'turn.ended' && record.agentId === 'main') {
      started = false;
      if (prompt !== undefined && Number.isSafeInteger(record.turnId)) completedPrompt = { text: prompt, turnId: record.turnId };
    }
    const message = record.type === 'agent.message.appended' ? record.message?.message : record.type === 'context.append_message' ? record.message : undefined;
    if (!message || !Array.isArray(message.content)) continue;
    const at = Number.isFinite(record.time) ? record.time : time;
    const textParts = message.content.flatMap((part: any) => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []);
    const text = textParts.join('\n');
    if (message.role === 'tool') {
      const tool = calls.get(message.toolCallId);
      if (tool) { tool.output = textParts.length ? text : portableText(message.content); tool.endedAt = at; }
      continue;
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const thought = message.content.flatMap((part: any) => part?.type === 'think' && typeof part.think === 'string' ? [part.think] : []).join('\n');
    if (thought.trim()) history.push({ kind: 'reasoning', text: thought, time: at });
    if (text.trim()) history.push({ role: message.role, text, time: at });
    if (message.role === 'assistant' && Array.isArray(message.toolCalls)) for (const call of message.toolCalls) {
      const definition = call?.function ?? call;
      if (typeof call?.id !== 'string' || typeof definition.name !== 'string') continue;
      const tool: PortableTool = { kind: 'tool', callId: call.id, name: definition.name, arguments: portableText(definition.arguments), time: at };
      calls.set(tool.callId, tool);
      history.push(tool);
    }
  }
  return { state, directory, stateFile, wireFile, stateRaw, wireRaw, history, archived: portableMessages(history), tokenReports, turnId, completedPrompt, busy: started, version: createHash('sha256').update(stateRaw).update('\0').update(wireRaw).digest('hex') };
}

export async function readKimiCheckpoint(home: string, cwd: string, id: string, expected: KimiCheckpoint) {
  // The ACP prompt response can precede the asynchronous native wire flush.
  for (let attempt = 0; attempt < 20; attempt++) {
    const native = await readKimiHistory(home, cwd, id).catch(error => {
      if (error instanceof SyntaxError || error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (native?.completedPrompt && !native.busy && native.completedPrompt.turnId > expected.afterTurn &&
        native.completedPrompt.text === expected.text) return native;
    await delay(50);
  }
  throw new Error('Kimi Code 尚未写完本轮原生记录，已保留之前的统一上下文');
}

function kimiTurns(entries: readonly PortableEntry[], now: number, previousTurn = -1) {
  const wire: Record<string, unknown>[] = [];
  let turnId = previousTurn;
  let hasReply = false, open = false;
  let lastPrompt = '';
  const end = (time: number) => wire.push({ type: 'turn.ended', agentId: 'main', turnId, reason: hasReply ? 'completed' : 'cancelled', time });
  for (const entry of completedEntries(entries)) {
    const user = 'role' in entry && entry.role === 'user';
    if (user) lastPrompt = entry.text;
    if (user || !open) {
      if (open) end(entry.time);
      turnId++;
      hasReply = false;
      open = true;
      wire.push({ type: 'turn.prompt', agentId: 'main', input: user ? [{ type: 'text', text: entry.text }] : [], origin: user ? { kind: 'user' } : { kind: 'system_trigger', name: 'imported_orphan' }, time: entry.time });
    }
    if ('role' in entry) wire.push({ type: 'context.append_message', message: { role: entry.role, content: [{ type: 'text', text: entry.text }], toolCalls: [] } });
    else {
      wire.push({ type: 'context.append_message', message: { role: 'assistant', content: [], toolCalls: [{ type: 'function', id: entry.callId, function: { name: entry.name, arguments: JSON.stringify(toolArguments(entry.arguments)) } }] } });
      wire.push({ type: 'context.append_message', message: { role: 'tool', content: [{ type: 'text', text: entry.output }], toolCalls: [], toolCallId: entry.callId } });
    }
    if (!user) hasReply = true;
  }
  if (open) end(now);
  return { wire, lastPrompt, hasReply };
}

export async function writeKimiHistory(home: string, cwd: string, title: string, messages: readonly PortableEntry[]) {
  if (!path.isAbsolute(home) || !path.isAbsolute(cwd) || !messages.length) throw new Error('Kimi Code 历史目录或上下文无效');
  const id = `ses_${randomUUID()}`;
  const parent = path.join(home, 'sessions', bucket(cwd));
  const directory = path.join(parent, id);
  const staging = path.join(parent, `.${id}.tmp`);
  const now = Date.now();
  const { wire, lastPrompt, hasReply } = kimiTurns(messages, now);
  wire.unshift({ type: 'metadata', protocol_version: '1.0', created_at: now });
  const state = {
    id, version: 2, cwd, createdAt: now, updatedAt: now, archived: false, title, titleKind: 'generated', isCustomTitle: false,
    lastPrompt: lastPrompt.slice(0, 200), lastTurnReason: hasReply ? 'completed' : 'cancelled',
    agents: { main: { homedir: path.join(directory, 'agents', 'main'), type: 'main', parentAgentId: null } },
  };
  await mkdir(parent, { recursive: true });
  await mkdir(staging);
  try {
    const main = path.join(staging, 'agents', 'main');
    await mkdir(main, { recursive: true });
    await writeFile(path.join(main, 'wire.jsonl'), wire.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' });
    await writeFile(path.join(staging, 'state.json'), JSON.stringify(state, null, 2), { flag: 'wx' });
    await rename(staging, directory);
  } finally { await rm(staging, { recursive: true, force: true }); }
  await appendFile(path.join(home, 'session_index.jsonl'), JSON.stringify({ sessionId: id, sessionDir: directory, workDir: cwd }) + '\n', 'utf8');
  return { id, directory };
}

export async function kimiHistoryVersion(home: string, cwd: string, id: string) {
  const directory = await sessionFolder(home, cwd, id);
  const files = await Promise.all([kimiStateFile(directory).then(file => stat(file)), stat(path.join(directory, 'agents', 'main', 'wire.jsonl'))]);
  return files.map(file => `${file.size}:${file.mtimeMs}`).join('/');
}

export async function appendKimiHistory(home: string, cwd: string, id: string, expected: string, messages: readonly PortableEntry[]) {
  await sessionFolder(home, cwd, id);
  const lock = path.join(home, 'locks', 'sessions', `${id}.lock`);
  const token = `${process.pid}:${randomUUID()}`;
  const temporary = `${lock}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(temporary, JSON.stringify({ version: 1, token, pid: process.pid, hostname: os.hostname(), startedAt: Date.now(), clientIdentity: 'entrotect', clientDisplayName: 'EntroTect' }), { flag: 'wx' });
  try {
    await link(temporary, lock).catch(error => {
      if (error.code === 'EEXIST') throw new Error('Kimi Code 会话正在使用，已暂缓写回');
      throw error;
    });
    const native = await readKimiHistory(home, cwd, id);
    if (native.version !== expected || native.busy) throw new Error('Kimi Code 会话已更新或还未结束');
    const now = Date.now();
    const { wire, lastPrompt, hasReply } = kimiTurns(messages, now, native.turnId);
    await atomicFile(native.wireFile, native.wireRaw.trimEnd() + '\n' + wire.map(row => JSON.stringify(row)).join('\n') + '\n', native.wireRaw);
    await atomicJson(native.stateFile, { ...native.state, updatedAt: now, lastPrompt: lastPrompt.slice(0, 200) || native.state.lastPrompt, lastTurnReason: hasReply ? 'completed' : 'cancelled' }, native.stateRaw);
  } finally {
    const holder = await readFile(lock, 'utf8').then(JSON.parse).catch(() => undefined);
    if (holder?.token === token) await unlink(lock);
    await unlink(temporary).catch(() => {});
  }
}
