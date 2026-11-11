import { appendFile, lstat, mkdir, readFile, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Conversation, DisplayItem } from '../shared/types';
import { projectKey } from '../shared/project-path';

export async function atomicJson(file: string, data: unknown, expectedContent?: string | null) {
  return atomicFile(file, JSON.stringify(data, null, 2), expectedContent);
}
export async function atomicFile(file: string, data: string | Uint8Array, expectedContent?: string | Uint8Array | null) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data);
    for (let attempt = 0; ; attempt++) {
      if (expectedContent !== undefined) {
        const current = await readFile(file).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
        if (expectedContent === null ? current !== null : !current?.equals(Buffer.from(expectedContent))) throw new Error('文件在保存期间被其他程序更新，请稍后重试');
      }
      try { await rename(temporary, file); return; }
      catch (error) {
        // Windows antivirus/indexers may briefly hold a handle without
        // FILE_SHARE_DELETE. Retry the atomic replacement; never unlink the old
        // index. A vendor registry precondition is checked again on each retry.
        if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt));
      }
    }
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export class Store {
  readonly conversations = new Map<string, Conversation>();
  private writes = new Map<string, Promise<unknown>>();
  private registeredProjects: string[] = [];
  constructor(readonly root: string) {}
  directory(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的对话 ID'); return path.join(this.root, 'conversations', id); }
  async init() {
    await mkdir(this.root, { recursive: true });
    try {
      const saved: Conversation[] = JSON.parse(await readFile(path.join(this.root, 'conversations.json'), 'utf8'));
      for (const conversation of saved) {
        if (['starting', 'running', 'waiting', 'stopping', 'syncing'].includes(conversation.state)) {
          conversation.state = 'error'; conversation.error = '上次运行被中断。发送下一条消息可恢复原生会话。';
        }
        this.conversations.set(conversation.id, conversation);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try {
      const saved: string[] = JSON.parse(await readFile(path.join(this.root, 'projects.json'), 'utf8'));
      this.registeredProjects = saved.filter(directory => typeof directory === 'string' && path.isAbsolute(directory));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  projects() { return [...this.registeredProjects]; }
  async addProject(workspace: string) {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || !(await stat(workspace).catch(() => null))?.isDirectory()) {
      throw new Error('请选择有效的项目目录');
    }
    const directory = path.resolve(workspace);
    return this.queue('projects', async () => {
      const key = projectKey(directory);
      const existing = this.registeredProjects.find(project => projectKey(project) === key);
      if (existing) return existing;
      const projects = [directory, ...this.registeredProjects];
      await atomicJson(path.join(this.root, 'projects.json'), projects);
      this.registeredProjects = projects;
      return directory;
    });
  }
  async createProject(parent: string, name: string) {
    if (typeof parent !== 'string' || !path.isAbsolute(parent) || !(await stat(parent).catch(() => null))?.isDirectory()) {
      throw new Error('请选择有效的上级目录');
    }
    const folder = typeof name === 'string' ? name.trim() : '';
    if (!folder || /[<>:"/\\|?*\x00-\x1f]|\.$/u.test(folder) || /^(con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(folder)) {
      throw new Error('请输入有效的 Windows 文件夹名称');
    }
    const directory = path.join(path.resolve(parent), folder);
    try { await mkdir(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('该目录已存在，可在「打开目录」中选择它');
      throw error;
    }
    try { return await this.addProject(directory); }
    catch (error) {
      // Only undo the empty directory created by this request.
      await rmdir(directory).catch(() => {});
      throw error;
    }
  }
  get(id: string) { const c = this.conversations.get(id); if (!c) throw new Error('对话不存在'); return c; }
  list() { return [...this.conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt); }
  async save(conversation: Conversation) {
    this.conversations.set(conversation.id, conversation);
    await this.queue('index', () => atomicJson(path.join(this.root, 'conversations.json'), this.list()));
  }
  async append(id: string, channel: 'display' | 'native', value: unknown) {
    await this.queue(`${id}:${channel}`, async () => {
      const dir = this.directory(id); await mkdir(dir, { recursive: true });
      await appendFile(path.join(dir, `${channel}.jsonl`), JSON.stringify(value) + '\n');
    });
  }
  async replaceItems(id: string, items: DisplayItem[]) {
    await this.queue(`${id}:display`,()=>atomicFile(path.join(this.directory(id),'display.jsonl'), items.map(i=>JSON.stringify(i)).join('\n')+'\n'));
  }
  async discardUnpublished(id:string){
    if(this.conversations.has(id))return;
    const target=this.directory(id),base=path.resolve(this.root,'conversations');
    if(!path.resolve(target).startsWith(base+path.sep)||path.basename(target)!==id)throw Error('无效的临时会话路径');
    const info=await lstat(target).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return null;throw e;});if(!info||info.isSymbolicLink())return;
    const actualBase=await realpath(base),actualTarget=await realpath(target);
    if(!actualTarget.startsWith(actualBase+path.sep)||path.basename(actualTarget)!==id)throw Error('临时目录超出了应用数据目录');
    await rm(target,{recursive:true,force:true});
  }
  async items(id: string): Promise<DisplayItem[]> {
    await this.writes.get(`${id}:display`);
    try {
      const text = await readFile(path.join(this.directory(id), 'display.jsonl'), 'utf8');
      const entries = new Map<string, DisplayItem>();
      for (const line of text.trimEnd().split('\n')) if (line) { const item = JSON.parse(line); entries.set(item.id, item); }
      return [...entries.values()];
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private queue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.writes.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(fn); this.writes.set(key, next); return next;
  }
}
