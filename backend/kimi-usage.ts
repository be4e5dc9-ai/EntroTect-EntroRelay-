import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export type KimiNativeUsage =
  | { kind: 'ok'; quota: { usages?: Record<string, { usedRatio?: unknown; resetAt?: unknown }>; extraUsage?: { balanceCents?: unknown; currency?: unknown } | null } }
  | { kind: 'error'; status?: number; message?: string };

export async function kimiNativeUsage(executable: string, prefix: string[], home: string, env: NodeJS.ProcessEnv): Promise<KimiNativeUsage> {
  // The native API handles OAuth and token refresh. Bind only to loopback and
  // ask the CLI for an ephemeral port so an existing Kimi server is unaffected.
  const child = spawn(executable, [...prefix, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'],
    { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let closed = false;
  const exited = new Promise<void>(resolve => {
    const finish = () => { closed = true; resolve(); };
    child.once('exit', finish);
    child.once('error', finish);
  });
  const startup = new AbortController();
  const origin = new Promise<string>((resolve, reject) => {
    let output = '';
    const inspect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-4096);
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d{1,5})(?=\/|\s|$)/);
      if (match && Number(match[1]) > 0 && Number(match[1]) <= 65535) resolve(match[0]);
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    void exited.then(() => reject(new Error('Kimi Code 用量服务未启动')));
    startup.signal.addEventListener('abort', () => reject(new Error('Kimi Code 用量服务启动超时')), { once: true });
  });
  const timer = setTimeout(() => startup.abort(), 10_000);
  let base: string | undefined, headers: { Authorization: string } | undefined;
  try {
    base = await origin;
    clearTimeout(timer);
    const token = (await readFile(path.join(home, 'server.token'), 'utf8')).trim();
    if (!token || /\s/.test(token)) throw new Error('Kimi Code 本地服务凭据无效');
    headers = { Authorization: `Bearer ${token}` };
    const response = await fetch(`${base}/api/v1/oauth/usage`, { headers, redirect: 'error', signal: AbortSignal.timeout(9_000) });
    if (!response.ok) return { kind: 'error', status: response.status };
    const result = await response.json();
    if (result?.code !== 0 || !['ok', 'error'].includes(result.data?.kind) ||
        result.data.kind === 'ok' && !result.data.quota) throw new Error('Kimi Code 返回了无效的用量信息');
    return result.data;
  } finally {
    clearTimeout(timer);
    if (!closed && base && headers) {
      await fetch(`${base}/api/v1/shutdown`, { headers, method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1_000) }).catch(() => {});
      await Promise.race([exited, delay(750, undefined, { ref: false })]);
    }
    if (!closed) child.kill();
    await exited;
  }
}
