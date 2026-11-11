import {test,expect} from '@playwright/test';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {atomicJson,Store} from '../backend/store';
import {launchTauri} from './tauri-launch';

const execute = promisify(execFile);
async function sidebarWindow(pid: number) {
  const { stdout } = await execute('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-File', path.resolve('tests/sidebar-window.ps1'), String(pid),
  ], { windowsHide: true, timeout: 5000 });
  return JSON.parse(stdout) as { visible: boolean; onTop: boolean; x: number; y: number; width: number; height: number } | null;
}
test('project sidebar browses real files and staged and unstaged Git changes',async()=>{
 const base=path.resolve('.local',`sidebar-e2e-${Date.now()}`),workspace=path.join(base,'example-project'),data=path.join(base,'app');
 await mkdir(path.join(workspace,'src'),{recursive:true});
 const run=promisify(execFile),git=(...args:string[])=>run('git',['-C',workspace,...args],{windowsHide:true});
 await git('init','--initial-branch=main');await git('config','user.name','Local Test');await git('config','user.email','test@example.invalid');
 await writeFile(path.join(workspace,'package.json'),'{"name":"example-project","version":"1.0.0"}\n');
 const file=path.join(workspace,'src/index.ts');await writeFile(file,'export const message = "first version";\n');
 await git('add','.');await git('commit','-m','initial');
 await writeFile(file,'export const message = "staged version";\n');await git('add','src/index.ts');
 await writeFile(file,'export const message = "current version";\n');
 await writeFile(path.join(workspace,'src/new file.ts'),'export const added = true;\n');
 await writeFile(path.join(workspace,'preview.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=','base64'));
 await atomicJson(path.join(data,'settings.json'),{defaultWorkspace:workspace});
 const desktop=await launchTauri({...process.env,ENTROTECT_DATA_DIR:data});
 try{
  const page=await desktop.firstWindow();
  await page.getByRole('button',{name:'展开项目侧栏',exact:true}).click();
  const panel=page.getByRole('complementary',{name:'项目侧栏'});
  await expect(panel.getByText('工作现场',{exact:true})).toHaveCount(0);
  await panel.getByRole('button',{name:'src',exact:true}).click();
  await expect(panel.getByTitle('src/index.ts',{exact:true})).toBeVisible();
  await panel.screenshot({path:'.local/screenshots/project-sidebar-panel.png'});
  await page.screenshot({path:'.local/screenshots/project-sidebar.png'});
  await panel.getByTitle('src/index.ts',{exact:true}).click();
  const preview=panel.getByRole('region',{name:'文件预览',exact:true});
  await expect(preview.locator('.source-lines')).toContainText('current version');
  const files=panel.getByRole('tabpanel',{name:'项目文件'});
  await expect(files.getByTitle('src/index.ts',{exact:true})).toBeVisible();
  await page.screenshot({path:'.local/screenshots/sidebar-file-content.png'});
  await panel.getByTitle('展开文件预览',{exact:true}).click();
  const expanded=page.getByRole('dialog',{name:'文件预览',exact:true});await expect(expanded.locator('.source-lines')).toContainText('current version');
  await page.keyboard.press('Escape');await expect(expanded).toBeHidden();await expect(preview).toBeVisible();
  await panel.getByTitle('返回文件列表',{exact:true}).click();await expect(preview).toBeHidden();
  await files.getByTitle('preview.png',{exact:true}).click();
  const image=preview.getByRole('img',{name:'preview.png'});
  await expect.poll(()=>image.evaluate(element=>(element as HTMLImageElement).naturalWidth)).toBe(1);
  await panel.getByRole('tab',{name:/改动/}).click();
  const changes=panel.getByRole('tabpanel',{name:'Git 改动'});
  await expect(changes.getByTitle('src/new file.ts',{exact:true})).toBeVisible();
  await panel.screenshot({path:'.local/screenshots/project-changes-panel.png'});
  await changes.getByTitle('src/index.ts',{exact:true}).click();
  const diff=panel.getByRole('region',{name:'更改预览',exact:true});
  await expect(diff.getByRole('heading',{name:'已暂存的改动'})).toBeVisible();
  await expect(diff.getByRole('heading',{name:'未暂存的改动'})).toBeVisible();
  await expect(diff.locator('.diff-add')).toContainText(['+export const message = "staged version";','+export const message = "current version";']);
  await page.screenshot({path:'.local/screenshots/project-diff.png'});
  await diff.getByTitle('展开文件预览',{exact:true}).click();
  await expect(page.getByRole('dialog',{name:'更改预览',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await diff.getByTitle('关闭文件预览',{exact:true}).click();
  await changes.getByTitle('src/new file.ts',{exact:true}).click();
  await expect(diff.locator('.diff-add')).toContainText('+export const added = true;');
  await page.keyboard.press('Escape');
  await writeFile(path.join(workspace,'extra.txt'),'new external file\n');await panel.getByTitle('刷新项目',{exact:true}).click();
  await expect(panel.getByTitle('extra.txt',{exact:true})).toBeVisible();
 }finally{await desktop.close();}
});

test('conversation links open files at their cited lines and browse websites in the project sidebar', async () => {
  const base = path.resolve('.local', `sidebar-links-${Date.now()}`);
  const workspace = path.join(base, 'preview project'), data = path.join(base, 'app');
  const file = path.join(workspace, 'src', 'example file.ts');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Array.from({ length: 200 }, (_, index) => `// Line ${index + 1}`).join('\n'));
  const outside = path.join(base, 'outside.txt');
  await writeFile(outside, 'outside project contents');

  const scripts: string[] = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/signal?')) {
      scripts.push(req.url);
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' });
    res.end(`<!DOCTYPE html><title>Preview fixture</title><a href="/second" target="_blank">Second</a>
      <script>fetch('/signal?path='+location.pathname+'&bridge='+Boolean(window.__TAURI_INTERNALS__ || window.ipc))</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server has no port');
  const origin = `http://127.0.0.1:${address.port}`;
  const id = randomUUID(), now = Date.now(), store = new Store(data);
  await store.save({ id, title: '预览链接', workspace, harness: 'deepseek', createdAt: now, updatedAt: now, revision: 0, state: 'idle', bindings: {} });
  const absolute = encodeURI(file.replaceAll('\\', '/'));
  await store.replaceItems(id, [{ id: 'references', kind: 'assistant', harness: 'deepseek', time: now, text: [
    `[绝对路径](/${absolute}:123:2)`,
    '[相对路径](src/example%20file.ts#L8-L10)',
    `[本地文件 URI](${pathToFileURL(file).href}#L198)`,
    '`src/example file.ts:44`',
    `[项目外文件](${pathToFileURL(outside).href})`,
    `[打开开发页面](${origin}/first)`,
  ].join('\n\n') }]);
  await atomicJson(path.join(data, 'settings.json'), { defaultWorkspace: workspace });
  let desktop: Awaited<ReturnType<typeof launchTauri>> | undefined;
  try {
    desktop = await launchTauri({ ...process.env, ENTROTECT_DATA_DIR: data });
    const page = await desktop.firstWindow();
    await page.getByRole('region', { name: 'preview project', exact: true }).getByRole('button', { name: '预览链接', exact: true }).click();
    const panel = page.getByRole('complementary', { name: '项目侧栏' });
    const preview = panel.getByRole('region', { name: '文件预览' });
    await page.getByRole('link', { name: '绝对路径' }).click();
    await expect(preview.locator('.source-selection')).toHaveText('// Line 123');
    await expect.poll(() => preview.locator('.file-viewer-content').evaluate(element => element.scrollTop)).toBeGreaterThan(1000);
    await page.getByRole('link', { name: '相对路径' }).click();
    await expect(preview.locator('.source-selection')).toHaveText('// Line 8 // Line 9 // Line 10');
    await page.getByRole('link', { name: '本地文件 URI' }).click();
    await expect(preview.locator('.source-selection')).toHaveText('// Line 198');
    await page.getByRole('link', { name: 'src/example file.ts:44' }).click();
    await expect(preview.locator('.source-selection')).toHaveText('// Line 44');
    await page.getByRole('link', { name: '项目外文件' }).click();
    await expect(panel.getByRole('alert')).toContainText('只能预览当前项目内的文件');
    await expect(panel.getByText('outside project contents')).toHaveCount(0);

    await page.getByRole('link', { name: '打开开发页面' }).click();
    const web = panel.getByRole('tabpanel', { name: '网页预览' });
    const input = web.getByRole('textbox', { name: '网址' });
    const surface = web.locator('.web-preview-surface');
    const native = () => sidebarWindow(desktop!.pid);
    await expect(input).toHaveValue(`${origin}/first`);
    await expect.poll(() => scripts.includes('/signal?path=/first&bridge=false'), { timeout: 15_000 }).toBe(true);
    await expect(surface).not.toHaveAttribute('aria-busy', 'true');
    const expected = await surface.evaluate(slot => {
      const rect = slot.getBoundingClientRect();
      const x = Math.round(rect.left * devicePixelRatio), y = Math.round(rect.top * devicePixelRatio);
      return { x, y, width: Math.round(rect.right * devicePixelRatio) - x, height: Math.round(rect.bottom * devicePixelRatio) - y };
    });
    await expect.poll(native, { timeout: 10_000 }).toEqual({ ...expected, visible: true, onTop: true });

    await input.fill(`127.0.0.1:${address.port}/second`);
    await input.press('Enter');
    await expect.poll(() => scripts.includes('/signal?path=/second&bridge=false')).toBe(true);
    const back = web.getByRole('button', { name: '后退' });
    const forward = web.getByRole('button', { name: '前进' });
    await back.click();
    await expect(input).toHaveValue(`${origin}/first`);
    await forward.click();
    await expect(input).toHaveValue(`${origin}/second`);
    const loaded = scripts.length;
    await web.getByRole('button', { name: '重新加载网页' }).click();
    await expect.poll(() => scripts.length).toBeGreaterThan(loaded);

    const handle = page.getByRole('separator', { name: '调整右侧栏宽度' });
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + 180;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect.poll(async () => (await native())?.visible).toBe(false);
    await page.mouse.move(x - 32, y, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await native())?.width ?? 0).toBeGreaterThan(expected.width);

    await panel.getByRole('tab', { name: '文件' }).click();
    await expect(web).toBeHidden();
    await expect.poll(async () => (await native())?.visible).toBe(false);
    await panel.getByRole('tab', { name: '网页' }).click();
    await expect(input).toHaveValue(`${origin}/second`);
    await page.getByRole('button', { name: '设置与连接' }).click();
    await expect.poll(async () => (await native())?.visible).toBe(false);
    await page.getByRole('button', { name: '工作区', exact: true }).click();
    await expect.poll(async () => (await native())?.visible).toBe(true);
    await page.getByRole('button', { name: '收起项目侧栏' }).click();
    await expect.poll(async () => (await native())?.visible).toBe(false);
    await page.getByRole('button', { name: '展开项目侧栏' }).click();
    await expect(input).toHaveValue(`${origin}/second`);
    await expect.poll(async () => (await native())?.visible).toBe(true);
    await page.reload();
    await expect.poll(native).toBeNull();
  } finally {
    await desktop?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
