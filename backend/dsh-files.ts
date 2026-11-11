// Matches the pinned DSH persistence projectKey (UTF-16 units and 251-char cap).
export function dshProjectKey(cwd: string) {
  let readable = '', separator = false;
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i];
    if ('/\\:'.includes(ch)) { if (!separator) readable += '-'; separator = true; }
    else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) { readable += ch; separator = false; }
    else { readable += '~' + cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0'); separator = false; }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib';

const logNames = ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.v3.jsonl.zstd', 'session.v3.jsonl', 'session.jsonl.zstd', 'session.jsonl'];

export async function deepSeekLog(directory: string) {
  for (const name of logNames) {
    const file = path.join(directory, name);
    if (await access(file).then(() => true, () => false)) return file;
  }
}

export async function deepSeekHeader(file: string) {
  const input = createReadStream(file), stream = file.endsWith('.zstd') ? input.pipe(createZstdDecompress()) : input;
  if (stream !== input) input.once('error', error => stream.destroy(error));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of lines) return JSON.parse(line); throw new Error('会话日志为空'); }
  finally { lines.close(); stream.destroy(); input.destroy(); }
}

export async function deepSeekTranscript(file: string): Promise<any[]> {
  const limit = 128 * 1024 * 1024;
  if ((await stat(file)).size > limit) throw new Error('会话日志超过 128 MB，请先在原生 Harness 中压缩或拆分');
  const content = await readFile(file);
  let decoded = content;
  if (file.endsWith('.zstd')) {
    const chunks: Buffer[] = []; let offset = 0, size = 0;
    // The native log can contain several concatenated frames.
    while (offset < content.length) {
      const frame = zstdDecompressSync(content.subarray(offset), { maxOutputLength: limit - size, info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      if (!frame.engine.bytesWritten) throw new Error('Zstandard 日志包含无效帧');
      chunks.push(frame.buffer); size += frame.buffer.length; offset += frame.engine.bytesWritten;
      if (size >= limit && offset < content.length) throw new Error('会话日志超过 128 MB');
    }
    decoded = Buffer.concat(chunks);
  }
  if (decoded.length > limit) throw new Error('会话日志超过 128 MB，请先在原生 Harness 中压缩或拆分');
  return decoded.toString('utf8').trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
