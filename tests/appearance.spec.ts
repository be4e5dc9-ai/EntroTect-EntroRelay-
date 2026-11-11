import { expect, test, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from '../backend/store';
import { modelFixture } from './fixture-server';
import { launchTauri } from './tauri-launch';

function textStyle(locator: Locator) {
  return locator.evaluate(element => {
    const { color, opacity, webkitTextFillColor } = getComputedStyle(element);
    return { color, opacity, webkitTextFillColor };
  });
}

test('neutral surfaces, pink accent, and readable labels while actions are pending', async () => {
  const root = path.resolve('.local', `appearance-e2e-${Date.now()}`);
  const data = path.join(root, 'app');
  const workspace = path.join(root, 'project');
  await mkdir(workspace, { recursive: true });
  const fixture = await modelFixture();
  await atomicJson(path.join(data, 'settings.json'), {
    defaultWorkspace: workspace,
    deepseek: { authMode: 'api', provider: 'deepseek-official', baseUrl: fixture.origin },
  });
  const desktop = await launchTauri({ ...process.env, ENTROTECT_DATA_DIR: data });
  try {
    const page = await desktop.firstWindow();
    await page.evaluate(async () => {
      const api = window.entrotect!;
      await api.saveSettings((await api.bootstrap()).settings, { deepseek: 'appearance-test-key' });
    });
    const input = page.getByRole('textbox', { name: '任务输入' });
    const state = page.getByRole('status', { name: '运行状态' });
    await input.fill('界面颜色验证');
    await input.press('Enter');
    await expect(page.locator('.message.assistant')).toContainText('ALPHA-731');
    await expect(state).toHaveText('就绪');

    const model = page.getByRole('combobox', { name: '选择模型' });
    const harness = page.getByRole('combobox', { name: '选择 Harness' });
    const reasoning = page.getByRole('button', { name: /^选择思考强度/ });
    const activeChat = page.locator('.conversation-row.selected');
    const response = page.locator('.message.assistant .message-body').first();
    const labels = [activeChat, input, model, harness, reasoning, response];
    const ready = await Promise.all(labels.map(textStyle));

    // Hold the picker request so the workspace stays in its disabled state.
    await page.evaluate(() => {
      window.entrotect!.chooseDirectory = () => new Promise(resolve => {
        window.addEventListener('test-cancel-directory', () => resolve(null), { once: true });
      });
    });
    await page.locator('.project-crumb').click();
    await expect(activeChat).toBeDisabled();
    await expect(model).toBeDisabled();
    expect.soft(await Promise.all(labels.map(textStyle)), 'pending labels keep their ready-state contrast').toEqual(ready);
    await page.evaluate(() => window.dispatchEvent(new Event('test-cancel-directory')));
    await expect(activeChat).toBeEnabled();

    fixture.hold(true);
    await input.fill('运行中检查字色');
    await input.press('Enter');
    await expect(state).toHaveText('正在工作');
    await expect(model).toBeDisabled();
    expect.soft(await Promise.all(labels.map(textStyle)), 'running labels keep their ready-state contrast').toEqual(ready);
    await page.screenshot({ path: '.local/screenshots/appearance-running.png' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.working .spin')).toHaveCSS('animation-name', 'none');
    expect(await page.locator('.live-dot.busy').evaluate(element => getComputedStyle(element, '::after').display)).toBe('none');
    await page.getByRole('button', { name: '暂停任务' }).click();
    await expect(state).toHaveText('就绪');

    expect.soft(await page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(244, 244, 244)');
    expect.soft(await page.locator('.sidebar').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(247, 247, 247)');
    expect.soft(await page.locator('.message.user').first().evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(250, 238, 244)');
    expect.soft((await textStyle(response)).color).toBe('rgb(26, 28, 31)');

    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '添加项目' })).toBeVisible();
    await expect(page.locator('.modal-backdrop')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.08)');
    await page.screenshot({ path: '.local/screenshots/appearance-project.png' });
    await page.getByRole('dialog', { name: '添加项目' }).getByRole('button', { name: '取消' }).click();
    const settings = page.getByRole('dialog', { name: '设置与连接' });
    async function appearance() {
      await page.getByRole('button', { name: '设置与连接' }).click();
      await settings.getByRole('button', { name: '外观', exact: true }).click();
    }
    const html = page.locator('html');
    await appearance();
    await settings.getByRole('button', { name: /^月之暗面/ }).click();
    await settings.getByRole('button', { name: '蓝色', exact: true }).click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(html).toHaveAttribute('data-accent', 'blue');
    await settings.getByRole('button', { name: '取消', exact: true }).click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await expect(html).toHaveAttribute('data-accent', 'pink');
    await appearance();
    await settings.getByRole('button', { name: '紫色', exact: true }).click();
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settings).toBeHidden();
    await page.reload();
    await expect(html).toHaveAttribute('data-accent', 'violet');
  } finally {
    await desktop.close();
    await fixture.close();
  }
});
