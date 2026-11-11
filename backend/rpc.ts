import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import type { LaunchConfig } from '../shared/types';

type Pending = { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout };
export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) { super(message); }
}

export class RpcProcess extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stderr: string[] = [];
  private pending = new Map<string, Pending>();
  private sequence = 0;
  exited = false;
  private failed = false;
  private exitPromise: Promise<void>;
  private closing?: Promise<void>;
  get available() { return !this.exited && !this.failed && !this.closing && !this.child.stdin.writableEnded; }
  constructor(config: Pick<LaunchConfig, 'executable' | 'args'>, cwd: string, env: NodeJS.ProcessEnv, readonly jsonrpc: boolean, private readonly nodeIpc = jsonrpc) {
    super();
    // Structured arguments, never shell-interpolated commands. SDK prompts use
    // stdin; the official standalone ZCode CLI accepts a prompt argument.
    // All three standard streams are pipes in both launch modes.
    this.child = spawn(config.executable, config.args, { cwd, env, windowsHide: true, stdio: nodeIpc ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    this.child.on('message', (frame: any) => {
      if (frame?.channel === 'entrotect.commands') this.resolveReply(frame);
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => { this.stderr.push(chunk); if (this.stderr.length > 30) this.stderr.shift(); this.emit('diagnostic', chunk); });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (!line.trim()) return;
      try {
        const frame = JSON.parse(line);
        if (frame.id !== undefined && !frame.method) {
          this.resolveReply(frame);
        } else if (frame.method && frame.id !== undefined) this.emit('request', frame);
        else if (frame.method) this.emit('notification', frame);
        else if (frame.type) this.emit('frame', frame);
        else this.emit('diagnostic', '未识别的协议帧');
      } catch { this.fail(new Error(`协议输出不是有效 JSON：${line.slice(0, 200)}`)); }
    });
    this.exitPromise = new Promise(resolve => {
      this.child.once('error', error => { this.fail(error, true); resolve(); });
      this.child.once('close', (code, signal) => { this.fail(new Error(`执行器已退出 (${code ?? signal})${this.stderr.length ? '\n' + this.stderr.join('').slice(-1800) : ''}`), true); resolve(); });
    });
    this.child.stdin.on('error', error => this.fail(error));
  }
  private resolveReply(frame: { id: string; error?: any; result?: unknown }) {
    const id = String(frame.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (frame.error) pending.reject(new RpcError(frame.error.message ?? (typeof frame.error === 'string' ? frame.error : JSON.stringify(frame.error)), frame.error.code, frame.error.data));
    else pending.resolve(frame.result);
  }
  private fail(error: Error, exited = false) {
    if (exited) this.exited = true;
    if (this.failed) return; this.failed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.emit('closed', error);
  }
  write(value: unknown) { if (this.exited || this.failed) throw new Error('执行器连接已关闭'); this.child.stdin.write(JSON.stringify(value) + '\n'); }
  notify(method: string, params?: unknown) {
    this.write({ ...(this.jsonrpc ? { jsonrpc: '2.0' } : {}), method, ...(params === undefined ? {} : { params }) });
  }
  request(method: string, params?: unknown, timeout = 90_000): Promise<any> {
    return this.requestWith(method, timeout, id => this.write({ ...(this.jsonrpc ? { jsonrpc: '2.0' } : {}), id, method, ...(params === undefined ? {} : { params }) }));
  }
  dshCommand(action: 'list' | 'execute', sessionId: string, line?: string) {
    return this.dshRequest(action, action === 'list' ? 8_000 : 24 * 60 * 60 * 1000, sessionId, line);
  }
  dshRequest(action: 'list' | 'execute' | 'balance' | 'context' | 'flush' | 'pause', timeout: number, sessionId?: string, line?: string) {
    return this.requestWith(action, timeout, id => {
      if (!this.child.connected) throw new Error('当前 DeepSeek 启动程序未连接命令通道');
      this.child.send({ channel: 'entrotect.commands', id, action, sessionId, line }, error => {
        if (error) this.resolveReply({ id, error });
      });
    });
  }
  private requestWith(method: string, timeout: number, send: (id: string) => void): Promise<any> {
    if (this.exited || this.failed) return Promise.reject(new Error('执行器连接已关闭'));
    const id = `e${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 等待响应超时，操作可能仍在后台执行`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { send(id); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  respond(id: string | number, result: unknown) { this.write({ ...(this.jsonrpc ? { jsonrpc: '2.0' } : {}), id, result }); }
  rejectRequest(id: string | number, message: string) { this.write({ ...(this.jsonrpc ? { jsonrpc: '2.0' } : {}), id, error: { code: -32601, message } }); }
  close() {
    if (!this.closing) {
      this.closing = this.closeOnce();
      void this.closing.catch(() => { this.closing = undefined; });
    }
    return this.closing;
  }
  private async closeOnce() {
    if (this.exited) return;
    if (this.nodeIpc && !this.failed) {
      if (this.child.connected) this.child.send({ channel: 'entrotect.commands', action: 'cancel' }, () => {});
      await this.request('shutdown', undefined, 2500).catch(() => {});
      // Let the SDK flush and dispose its runtime before closing its pipes.
      await Promise.race([this.exitPromise, new Promise(r => setTimeout(r, 2200))]);
      if (this.exited) return;
    }
    this.child.stdin.end();
    await Promise.race([this.exitPromise, new Promise(r => setTimeout(r, 2200))]);
    const processExited = () => this.child.exitCode !== null || this.child.signalCode !== null;
    if (!this.exited && !processExited() && this.child.pid) {
      await new Promise<void>(resolve => {
        const killer = spawn('taskkill.exe', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('exit', () => resolve()); killer.once('error', () => resolve());
      });
      await Promise.race([this.exitPromise, new Promise(r => setTimeout(r, 1500))]);
    }
    if (!this.exited && processExited()) {
      // A helper can keep a pipe open after the runtime has exited. The
      // process exit code is authoritative and its PID must not be reused.
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      this.fail(new Error('执行器已退出'), true);
    }
    if (!this.exited) throw new Error('尚未确认执行器退出，暂不能切换');
  }
}
