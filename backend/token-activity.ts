import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { harnesses, type Harness, type TokenDay } from '../shared/types';
import type { Store } from './store';

const dayFormat = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' });

export type NativeTokenReport = { id: string; tokens: number; time: number };
const emptyDay = (day: string): TokenDay => ({ day, deepseek: 0, zcode: 0, kimi: 0, opencode: 0, codex: 0 });

export function sumReportedTokens(required: readonly unknown[], optional: readonly unknown[] = []) {
  if (required.some(value => value == null)) return;
  let total = 0;
  for (const value of [...required, ...optional.filter(value => value != null)]) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return;
    total += value;
  }
  return Number.isSafeInteger(total) ? total : undefined;
}

function modelRequest(row: any, codexTurns: Map<string, number | undefined>): { harness: Harness; key: string; tokens: number } | undefined {
  const frame = row?.frame;
  if (row?.harness === 'deepseek' && frame?.method === 'session.event') {
    const { event, sessionId } = frame.params ?? {};
    if (event?.type !== 'assistant/message' || typeof sessionId !== 'string') return;
    const id = event.data?.message?.id ?? event.seq;
    if (id === undefined) return;
    return { harness: 'deepseek', key: `deepseek:${sessionId}:${id}`, tokens: event.data?.usage?.totalTokens };
  }
  if (row?.harness === 'zcode') {
    const event = frame?.method === 'session/event' ? frame.params : frame;
    const data = event?.payload;
    // session.updated also reports context usage for this call. Only the
    // provider completion event represents a distinct billed request.
    if (event?.type !== 'session.updated' || data?.type !== 'model_request_completed' || typeof data.requestId !== 'string') return;
    return { harness: 'zcode', key: `zcode:${data.requestId}:${data.attempt ?? 0}`, tokens: data.usage?.totalTokens };
  }
  if (row?.harness === 'codex') {
    const params = frame?.params;
    if (typeof params?.threadId !== 'string') return;
    if (frame.method === 'turn/started' && typeof params.turn?.id === 'string') {
      codexTurns.set(`${params.threadId}:${params.turn.id}`, undefined);
    }
    if (frame.method !== 'thread/tokenUsage/updated' || typeof params.turnId !== 'string') return;
    const turn = `${params.threadId}:${params.turnId}`;
    if (!codexTurns.has(turn)) return; // Resume can replay usage from a previous turn.
    const total = sumReportedTokens([params.tokenUsage?.total?.totalTokens]);
    const last = sumReportedTokens([params.tokenUsage?.last?.totalTokens]);
    const previous = codexTurns.get(turn);
    if (total === undefined || last === undefined || (previous !== undefined && total <= previous)) return;
    codexTurns.set(turn, total);
    return { harness: 'codex', key: `codex:${turn}:${total}`, tokens: previous === undefined ? last : total - previous };
  }
}

async function readLog(file: string) {
  const days = new Map<string, TokenDay>();
  const seen = new Set<string>();
  const codexTurns = new Map<string, number | undefined>();
  const record = (harness: Harness, key: string, tokens: number, time: number) => {
    if (!Number.isSafeInteger(tokens) || tokens <= 0 || seen.has(key) ||
        typeof time !== 'number' || !Number.isFinite(time) || Math.abs(time) > 8.64e15) return;
    seen.add(key);
    const day = dayFormat.format(time);
    const totals = days.get(day) ?? emptyDay(day);
    totals[harness] += tokens;
    days.set(day, totals);
  };
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.kind === 'model-usage' && (row.harness === 'kimi' || row.harness === 'opencode') &&
          typeof row.runSessionId === 'string' && Array.isArray(row.reports)) {
        for (const report of row.reports) if (typeof report?.id === 'string') {
          record(row.harness, `${row.harness}:${row.runSessionId}:${report.id}`, report.tokens, report.time);
        }
        continue;
      }
      const request = modelRequest(row, codexTurns);
      if (request) record(request.harness, request.key, request.tokens, row.time);
    }
  } finally { stream.destroy(); }
  return days;
}

export class TokenActivity {
  private cache = new Map<string, { modified: number; size: number; days: Map<string, TokenDay> }>();
  private pending?: Promise<TokenDay[]>;
  constructor(private store: Store) {}

  read() {
    this.pending ??= this.scan().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async scan() {
    const combined = new Map<string, TokenDay>();
    for (const { id } of this.store.list()) {
      const file = path.join(this.store.directory(id), 'native.jsonl');
      const info = await stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info?.isFile()) { this.cache.delete(id); continue; }
      let cached = this.cache.get(id);
      if (!cached || cached.modified !== info.mtimeMs || cached.size !== info.size) {
        cached = { modified: info.mtimeMs, size: info.size, days: await readLog(file) };
        this.cache.set(id, cached);
      }
      for (const [day, counts] of cached.days) {
        const sum = combined.get(day) ?? emptyDay(day);
        for (const harness of harnesses) sum[harness] += counts[harness];
        combined.set(day, sum);
      }
    }
    return [...combined.values()].sort((a, b) => a.day.localeCompare(b.day));
  }
}
