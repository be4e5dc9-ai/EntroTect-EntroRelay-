import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { DirectoryListing, DiffPreview, FilePreview, GitChange, GitStatus } from '../shared/types';
import type { FileReference } from '../shared/preview-link';

const execute = promisify(execFile);
const previewLimit = 512 * 1024;
const imagePreviewLimit = 4 * 1024 * 1024;
const nameOrder = new Intl.Collator('zh-CN', { numeric: true });
const imageFormats: Record<string, { mime: NonNullable<FilePreview['image']>['mime']; matches(bytes: Buffer): boolean }> = {
  '.png': { mime: 'image/png', matches: bytes => bytes.subarray(0, 8).equals(pngSignature) },
  '.jpg': { mime: 'image/jpeg', matches: isJpeg },
  '.jpeg': { mime: 'image/jpeg', matches: isJpeg },
  '.gif': { mime: 'image/gif', matches: bytes => /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) },
  '.webp': { mime: 'image/webp', matches: bytes => bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' },
  '.bmp': { mime: 'image/bmp', matches: bytes => bytes.length >= 14 && bytes[0] === 0x42 && bytes[1] === 0x4d },
};
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function isJpeg(bytes: Buffer) { return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff; }
const slash = (value: string) => value.replaceAll('\\', '/');
function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
async function locate(workspace: string, relative = '', missing = false) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative)) throw new Error('无效的项目路径');
  const root = await realpath(workspace);
  if (!relative) return { root, target: root };
  const target = path.resolve(root, relative);
  if (!inside(root, target)) throw new Error('只能访问当前项目内的文件');
  let ancestor = target;
  while (true) {
    try { const resolved = await realpath(ancestor); if (!inside(root, resolved)) throw new Error('该链接指向项目目录之外'); break; }
    catch (error) {
      if (!missing || !['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') || ancestor === root) throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  return { root, target };
}
async function git(root: string, args: string[]) {
  const result = await execute('git', ['--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-C', root, ...args], {
    windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C' }, encoding: 'utf8',
  });
  return result.stdout;
}
function shorten(text: string) {
  const lines = text.slice(0, previewLimit).split('\n');
  return { text: lines.slice(0, 5000).join('\n'), truncated: text.length > previewLimit || lines.length > 5000 };
}
export class WorkspaceService {
  async files(workspace: string, relative = ''): Promise<DirectoryListing> {
    const { root, target } = await locate(workspace, relative);
    const entries = (await readdir(target, { withFileTypes: true })).filter(entry => entry.name !== '.git')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || nameOrder.compare(a.name, b.name));
    return { truncated: entries.length > 500, entries: entries.slice(0, 500).map(entry => ({ name: entry.name, path: slash(path.relative(root, path.join(target, entry.name))), kind: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : 'file' })) };
  }
  async read(workspace: string, relative: string, includeImage = true): Promise<FilePreview> {
    const { target } = await locate(workspace, relative);
    const handle = await open(target, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('请选择普通文件');
      const extension = path.extname(target).toLowerCase();
      const format = Object.hasOwn(imageFormats, extension) ? imageFormats[extension] : undefined;
      let limit = previewLimit;
      if (includeImage && format && info.size > previewLimit && info.size <= imagePreviewLimit) {
        const header = Buffer.alloc(14);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (format.matches(header.subarray(0, bytesRead))) limit = imagePreviewLimit;
      }
      const buffer = Buffer.alloc(Math.min(info.size, limit));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      const meta = { path: slash(relative), parent: path.dirname(target), size: info.size };
      const truncated = info.size > bytesRead;
      if (format?.matches(bytes)) {
        const image = includeImage && !truncated ? { mime: format.mime, base64: bytes.toString('base64') } : undefined;
        return { ...meta, text: '', binary: true, truncated, image };
      }
      const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
      let binary = encoding === 'utf-8' && bytes.includes(0), text = '';
      if (!binary) { try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated }); } catch { binary = true; } }
      const clipped = shorten(text.replaceAll('\r\n', '\n'));
      return { ...meta, text: clipped.text, binary, truncated: truncated || clipped.truncated };
    } finally { await handle.close(); }
  }
  async readReference(workspace: string, reference: FileReference): Promise<FilePreview> {
    const filename = reference?.path;
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new Error('请先打开对话对应的项目目录');
    if (typeof filename !== 'string' || !filename || /[\0\r\n]/.test(filename)
      || process.platform === 'win32' && (/^[/\\]{2}[?.][/\\]/.test(filename)
        || filename.replace(/^[a-z]:(?=[/\\])/i, '').includes(':'))) throw new Error('无效的文件引用');
    const target = path.resolve(workspace, filename);
    const root = inside(workspace, target) ? workspace : await realpath(workspace);
    if (!inside(root, target)) throw new Error('只能预览当前项目内的文件');
    try {
      return await this.read(workspace, path.relative(root, target));
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new Error('项目中找不到这个文件');
      throw error;
    }
  }
  async status(workspace: string): Promise<GitStatus> {
    const { root } = await locate(workspace);
    let repositoryRoot: string;
    try { repositoryRoot = (await git(root, ['rev-parse','--show-toplevel'])).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { available: false, repository: false, branch: '', changes: [] }; if ((error as {code?:number}).code === 128 && /not a git repository|not a git directory/i.test((error as {stderr?:string}).stderr ?? '')) return { available: true, repository: false, branch: '', changes: [] }; throw error; }
    const [raw, branch] = await Promise.all([
      git(root, ['status','--porcelain=v1','-z','--untracked-files=all','--','.']),
      git(root, ['symbolic-ref','--short','HEAD']).catch(() => git(root, ['rev-parse','--short','HEAD'])),
    ]);
    const fields = raw.split('\0'), changes: GitChange[] = [];
    for (let i = 0; i < fields.length; i++) {
      const row = fields[i]; if (!row) continue;
      const relative = path.relative(root, path.resolve(repositoryRoot, row.slice(3)));
      let oldPath: string | undefined;
      if (/[RC]/.test(row.slice(0, 2))) oldPath = slash(path.relative(root, path.resolve(repositoryRoot, fields[++i])));
      if (inside(root, path.resolve(root, relative))) changes.push({ path: slash(relative), ...(oldPath ? { oldPath } : {}), index: row[0], worktree: row[1] });
      else if (oldPath && inside(root, path.resolve(root, oldPath))) changes.push({ path: oldPath, index: 'D', worktree: ' ' });
    }
    return { available: true, repository: true, branch: branch.trim(), changes };
  }
  async diff(workspace: string, relative: string): Promise<DiffPreview> {
    const { root, target } = await locate(workspace, relative, true);
    const status = await this.status(workspace), change = status.changes.find(change => change.path === slash(relative));
    if (!change) throw new Error('该文件已不在改动列表中，请刷新');
    if (change.index === '?' && change.worktree === '?') {
      const file = await this.read(root, relative, false);
      const lines=file.text?file.text.replace(/\n$/,'').split('\n'):[];
      const added=`--- /dev/null\n+++ b/${relative}\n`+(lines.length?`@@ -0,0 +1,${lines.length} @@\n`+lines.map(line=>'+'+line).join('\n')+(file.text.endsWith('\n')||file.truncated?'':'\n\\ No newline at end of file'):'');
      return { path: relative, parent: path.dirname(target), staged: '', unstaged: file.binary ? '二进制或非 UTF-8 文件，无法显示文本差异。' : added, truncated: file.truncated };
    }
    const paths = [relative];
    if (change.oldPath && inside(root, path.resolve(root, change.oldPath))) paths.push(change.oldPath);
    const args = ['diff','--no-ext-diff','--no-textconv','--no-color','--no-renames'];
    const [staged, unstaged] = await Promise.all([git(root, [...args,'--cached','--',...paths]), git(root, [...args,'--',...paths])]);
    const a = shorten(staged), b = shorten(unstaged);
    return { path: relative, parent: path.dirname(target), staged: a.text, unstaged: b.text, truncated: a.truncated || b.truncated };
  }
}
