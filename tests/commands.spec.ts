import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson } from '../backend/store';
import { launchTauri } from './tauri-launch';
import { modelFixture } from './fixture-server';

test('slash menu follows the selected harness and runs native and plugin commands', async () => {
  const root = path.resolve('.local', `commands-e2e-${Date.now()}`);
  const workspace = path.join(root, 'project'), dsh = path.join(root, 'dsh');
  const profile = path.join(dsh, 'profiles', 'sdk');
  const zcode = path.join(root, 'zcode'), commands = path.join(workspace, '.zcode', 'commands');
  await mkdir(profile, { recursive: true });
  await mkdir(commands, { recursive: true });
  const plugin = path.join(root, 'test-command.mjs');
  await writeFile(plugin, `
    export const inject = ['commands'];
    export function apply(ctx) {
      ctx.commands.register({
        name: 'dsh-test',
        description: 'A test command from the DeepSeek profile',
        input: { hint: '<value>' },
        handler: ({ rawInput, signal }) => {
          if (rawInput.trim() !== 'WAIT') return { kind: 'success', text: 'DSH-PLUGIN' + rawInput };
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ kind: 'success', text: 'Unexpected completion' }), 30_000);
            signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
          });
        },
      });
    }
  `);
  await atomicJson(path.join(profile, 'cordis.patch.yml'), [{ insert: [{ id: 'test-command', name: pathToFileURL(plugin).href }] }]);
  await writeFile(path.join(commands, 'zcode-test.md'), '---\ndescription: A test command from the ZCode project\nargument-hint: <value>\n---\nZCODE-TEMPLATE $ARGUMENTS\n');
  const fixture = await modelFixture();
  const config = {
    deepseek: { executable: '@bundled/node', args: ['@bundled/deepseek', '--profile', 'sdk'], home: dsh, provider: 'deepseek-official', model: 'deepseek-flash', authMode: 'api', baseUrl: fixture.origin },
    zcode: { executable: '@bundled/node', args: ['@bundled/zcode', 'agent-server', '--stdio'], home: zcode, provider: 'test-local', model: 'glm-5.3', authMode: 'api', baseUrl: fixture.origin + '/v1' },
    defaultWorkspace: workspace,
  };
  await atomicJson(path.join(root, 'settings.json'), config);
  const desktop = await launchTauri({ ...process.env, ENTROTECT_DATA_DIR: root });
  try {
    const page = await desktop.firstWindow();
    const input = page.getByRole('textbox', { name: '任务输入' });
    const options = page.getByRole('listbox', { name: '斜杠命令' });
    const state = page.getByRole('status', { name: '运行状态' });
    const harness = page.getByRole('combobox', { name: '选择 Harness' });
    const model = page.getByRole('combobox', { name: '选择模型' });

    await page.evaluate(() => {
      const api = window.entrotect!;
      const listCommands = api.listCommands.bind(api);
      let reads = 0;
      api.listCommands = scope => {
        document.documentElement.dataset.catalogReads = String(++reads);
        return listCommands(scope);
      };
    });
    await input.fill('/');
    await expect(options.getByRole('option', { name: /\/dsh-test/ })).toBeVisible();
    await expect(options.getByRole('option', { name: /\/plan/ })).toBeVisible();
    await expect(options.getByRole('option', { name: /\/zcode-test/ })).toHaveCount(0);
    expect(fixture.requests).toHaveLength(0);
    await input.press('Escape');
    await expect(options).toBeHidden();
    await input.fill('/dsh');
    await expect(options.getByRole('option', { name: /\/dsh-test/ })).toBeVisible();
    await expect(page.getByText('正在读取命令…')).toHaveCount(0);
    // Check that reopening did not schedule a second request after the debounce.
    await page.waitForTimeout(200);
    await expect(page.locator('html')).toHaveAttribute('data-catalog-reads', '1');
    await page.evaluate(async () => {
      const boot = await window.entrotect!.bootstrap();
      await window.entrotect!.saveSettings(boot.settings, { deepseek: 'local-dsh-key', zcode: 'local-zcode-key' });
    });
    await input.fill('/dsh');
    await expect(options.getByRole('option')).toHaveCount(1);
    await input.press('Tab');
    await expect(input).toHaveValue('/dsh-test ');
    await input.fill('/dsh-test DSH-ARG');
    await input.press('Enter');
    await expect(state).toHaveText('就绪');
    const result = page.locator('.tool-message.command').filter({ hasText: '/dsh-test' });
    await result.locator('summary').click();
    await expect(result.locator('pre').last()).toHaveText('DSH-PLUGIN DSH-ARG');
    expect(fixture.requests).toHaveLength(0);

    await input.fill('/dsh-test WAIT');
    await input.press('Enter');
    await expect(state).toHaveText('正在工作');
    await page.getByRole('button', { name: '暂停任务' }).click();
    await expect(state).toHaveText('就绪', { timeout: 8_000 });
    await input.fill('/dsh-test AFTER-PAUSE');
    await input.press('Enter');
    await expect(state).toHaveText('就绪');
    await result.last().locator('summary').click();
    await expect(result.last().locator('pre').last()).toHaveText('DSH-PLUGIN AFTER-PAUSE');

    await input.fill('/unknown-command');
    await expect(page.getByText('没有匹配的命令')).toBeVisible();
    await input.press('Enter');
    await expect(page.getByRole('alert')).toContainText('当前不支持 /unknown-command');
    await expect(input).toHaveValue('/unknown-command');
    expect(fixture.requests).toHaveLength(0);

    // A manual override must drive discovery even though the selected model
    // still belongs to DeepSeek. Then use the usual GLM route for execution.
    await harness.selectOption('zcode');
    await expect(page.locator('.active-harness')).toHaveText('ZCode');
    await expect(model).toHaveValue('deepseek-flash');
    await input.fill('/');
    await expect(options.getByRole('option', { name: /\/zcode-test/ })).toBeVisible();
    await expect(options.getByRole('option', { name: /\/dsh-test/ })).toHaveCount(0);
    await writeFile(path.join(commands, 'zcode-new.md'), '---\ndescription: A newly installed command\n---\nNEW-TEMPLATE\n');
    await expect(options.getByRole('option', { name: /\/zcode-new/ })).toHaveCount(0);
    await page.getByRole('button', { name: '刷新斜杠命令' }).click();
    await expect(options.getByRole('option', { name: /\/zcode-new/ })).toBeVisible();
    await page.screenshot({ path: '.local/screenshots/zcode-slash-commands.png' });
    await model.selectOption('glm-5.3');
    await input.fill('/zcode-test');
    await expect(options.getByRole('option', { name: /\/zcode-test/ })).toBeVisible();
    await options.getByRole('option', { name: /\/zcode-test/ }).click();
    await expect(input).toHaveValue('/zcode-test ');
    await input.fill('/zcode-test ZCODE-ARG');
    const beforeCommand = fixture.requests.length;
    await input.press('Enter');
    await expect.poll(() => fixture.requests.slice(beforeCommand).some(request =>
      JSON.stringify(request.body.messages)?.includes('ZCODE-TEMPLATE ZCODE-ARG'))).toBe(true);
    await expect(state).toHaveText('就绪');

    fixture.reply('ZCODE-COMPACT-SUMMARY');
    await input.fill('/compact 保留标记');
    await input.press('Enter');
    await expect(state).toHaveText('就绪');
    const compact = page.locator('.tool-message.command').filter({ hasText: '/compact' });
    await compact.locator('summary').click();
    await expect(compact.locator('pre').last()).toHaveText('ZCode 已结束上下文压缩');
    const measurement = await page.evaluate(async () => (await window.entrotect!.bootstrap()).conversations[0]?.contextUsage);
    expect(measurement).toMatchObject({ harness: 'zcode', modelId: 'glm-5.3', source: 'native-estimate', windowTokens: 1_000_000 });
    await model.selectOption('deepseek-flash');
    await expect(page.locator('.active-harness')).toHaveText('DeepSeek Harness');
    fixture.reply('已从压缩后的上下文继续');
    await input.fill('继续刚才的任务');
    await input.press('Enter');
    await expect(state).toHaveText('就绪');
    expect(JSON.stringify(fixture.requests.at(-1)?.body.messages)).toContain('ZCODE-COMPACT-SUMMARY');
  } finally {
    await desktop.close();
    await fixture.close();
  }
});
