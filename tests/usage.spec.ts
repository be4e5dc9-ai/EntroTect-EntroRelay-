import { expect, test } from '@playwright/test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from '../backend/store';
import { modelFixture } from './fixture-server';
import { launchTauri } from './tauri-launch';

test('desktop themes, native reasoning, account usage and local token activity', async () => {
  const root = path.resolve('.local', `usage-e2e-${Date.now()}`);
  const data = path.join(root, 'app');
  const workspace = path.join(root, 'work');
  await mkdir(workspace, { recursive: true });
  const fixture = await modelFixture();
  await atomicJson(path.join(data, 'settings.json'), {
    defaultWorkspace: workspace,
    deepseek: { authMode: 'api', provider: 'deepseek-official', baseUrl: fixture.origin },
    zcode: { authMode: 'api', baseUrl: `${fixture.origin}/api/coding/paas/v4` },
  });
  const desktop = await launchTauri({ ...process.env, ENTROTECT_DATA_DIR: data });
  try {
    const page = await desktop.firstWindow();
    await page.evaluate(async () => {
      const desktop = window.entrotect!;
      await desktop.saveSettings((await desktop.bootstrap()).settings, { deepseek: 'test-balance-key', zcode: 'test-coding-plan-key' });
    });
    await page.reload();
    await page.emulateMedia({ colorScheme: 'dark' });
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'light');
    const settings = page.getByRole('dialog', { name: '设置与连接' });
    const settingsButton = page.getByRole('button', { name: '设置与连接', exact: true });
    await settingsButton.click();
    await settings.getByRole('button', { name: '外观', exact: true }).click();
    await settings.getByRole('button', { name: /^月之暗面/ }).click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: '.local/screenshots/settings-dark.png' });
    await settings.getByRole('button', { name: '取消', exact: true }).click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await settingsButton.click();
    await settings.getByRole('button', { name: '外观', exact: true }).click();
    await settings.getByRole('button', { name: /^跟随系统/ }).click();
    await settings.getByRole('button', { name: '保存设置' }).click();
    await expect(settings).toBeHidden();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(html).toHaveAttribute('data-theme', 'light');
    expect(JSON.parse(await readFile(path.join(data, 'settings.json'), 'utf8')).theme).toBe('system');

    const input = page.getByRole('textbox', { name: '任务输入' });
    const account = page.getByRole('button', { name: '套餐与 API 余额' });
    const context = page.getByRole('button', { name: '剩余上下文' });
    const reading = page.getByRole('region', { name: '上下文用量详情' });
    const details = page.getByRole('region', { name: '套餐与余额详情' });
    await expect(account).toHaveText('CNY 42.37');
    const composerBounds = (await input.boundingBox())!;
    expect(composerBounds.height).toBeGreaterThanOrEqual(76);
    const balanceBounds = (await account.boundingBox())!;
    expect(balanceBounds.y + balanceBounds.height).toBeLessThan(composerBounds.y + 3);
    expect(balanceBounds.x).toBeGreaterThan(composerBounds.x + composerBounds.width / 2);
    await input.fill('第一行\n第二行\n第三行\n第四行\n第五行');
    await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThan(composerBounds.height + 20);
    await input.clear();
    await account.click();
    await expect(details.locator('.wallet-row strong')).toHaveText(['CNY 42.37', 'CNY 40.00', 'CNY 2.37']);
    expect(fixture.usageRequests).toContainEqual({ path: '/user/balance', authorization: 'Bearer test-balance-key' });
    expect(fixture.requests).toHaveLength(0);

    const reasoning = page.getByRole('button', { name: /^选择思考强度/ });
    const reasoningPanel = page.getByRole('region', { name: '思考强度选项' });
    const slider = page.getByRole('slider', { name: '思考强度', exact: true });
    await reasoning.click();
    await expect(reasoningPanel).toHaveCSS('opacity', '1');
    const panelBounds = (await reasoningPanel.boundingBox())!;
    const composer = (await page.locator('.composer').boundingBox())!;
    const button = (await reasoning.boundingBox())!;
    expect(panelBounds.y).toBeGreaterThanOrEqual(composer.y);
    expect(panelBounds.y + panelBounds.height).toBeLessThan(button.y);
    expect(button.y - panelBounds.y - panelBounds.height).toBeLessThan(9);
    expect(balanceBounds.y + balanceBounds.height).toBeLessThan(panelBounds.y);
    await expect(slider).toHaveAttribute('max', '4');
    await expect(slider).toHaveAccessibleDescription(/auto、off、low、high、max/);
    await slider.press('End');
    await expect(slider).toHaveAttribute('aria-valuetext', 'max');
    await expect(reasoningPanel.locator('.reasoning-fill')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
    await expect(reasoningPanel.locator('.reasoning-fill')).toHaveCSS('background-color', 'rgb(225, 126, 173)');
    await expect(reasoningPanel.locator('header strong')).toHaveCSS('color', 'rgb(186, 74, 124)');
    const area = (await page.locator('.composer-area').boundingBox())!;
    const clip = { x: area.x - 8, y: area.y - 8, width: area.width + 16, height: area.height + 8 };
    await page.screenshot({ path: '.local/screenshots/reasoning-slider.png', clip });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(html).toHaveAttribute('data-theme', 'dark');
    expect(await page.locator('.composer').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(30, 30, 30)');
    await page.screenshot({ path: '.local/screenshots/reasoning-slider-dark.png', clip });
    await page.emulateMedia({ colorScheme: 'light' });
    await slider.press('Escape');
    await expect(reasoningPanel).toBeHidden();
    await input.fill('DeepSeek 用量验证');
    await input.press('Enter');
    const state = page.getByRole('status', { name: '运行状态' });
    await expect(state).toHaveText('就绪');
    expect(fixture.requests.at(-1)?.body.output_config.effort).toBe('max');
    await expect(context).toContainText('上下文剩余');
    await context.click();
    await expect(reading).toContainText('tokens 剩余');
    await page.screenshot({ path: '.local/screenshots/context-usage.png' });

    await page.getByRole('combobox', { name: '选择模型' }).selectOption('glm-5.3');
    await expect(page.locator('.active-harness')).toHaveText('ZCode');
    await expect(context).toHaveText('上下文');
    await expect(account).toHaveText('5 小时额度 78%');
    await account.click();
    await expect(details).toContainText('每周额度');
    await expect(details).toContainText('剩余 51%');
    await expect(details).toContainText('重置');
    await page.screenshot({ path: '.local/screenshots/account-usage.png' });
    expect(fixture.usageRequests).toContainEqual({ path: '/api/monitor/usage/quota/limit', authorization: 'test-coding-plan-key' });

    await reasoning.click();
    await expect(slider).toHaveAttribute('max', '3');
    await expect(slider).toHaveAccessibleDescription(/auto、low、high、max/);
    const bounds = (await slider.boundingBox())!;
    await page.mouse.move(bounds.x + 11, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 11 + (bounds.width - 22) / 3, bounds.y + bounds.height / 2, { steps: 5 });
    await expect(reasoningPanel.locator('header strong')).toHaveText('low');
    await expect(reasoningPanel.locator('.reasoning-fill')).toHaveCSS('transition-duration', '0s');
    await page.mouse.up();
    await expect(slider).toHaveAttribute('aria-valuetext', 'low');
    await input.fill('GLM 用量验证');
    await input.press('Enter');
    await expect(state).toHaveText('就绪');
    expect(fixture.requests.at(-1)?.body.reasoning_effort).toBe('low');
    await context.click();
    await expect(reading).toContainText('已用 100 / 1,000,000 tokens');
    await account.click();
    await details.getByRole('button', { name: '用量设置' }).click();
    const activity = settings.getByRole('region', { name: 'Token 活动' });
    await expect(activity.getByTitle(/200 tokens/)).toBeVisible();
    await page.screenshot({ path: '.local/screenshots/usage-activity.png' });
    await activity.getByRole('button', { name: '每周', exact: true }).click();
    await expect(activity.getByTitle(/200 tokens/)).toBeVisible();
    await activity.getByRole('button', { name: '累计总量', exact: true }).click();
    await expect(activity.locator('.activity-totals strong')).toHaveText(['200', '100', '100', '0', '0', '0']);
  } finally {
    await desktop.close();
    await fixture.close();
  }
});

test('DeepSeek native wallet lookup preserves the native grant on authentication rejection', async () => {
  const root = path.resolve('.local', `wallet-e2e-${Date.now()}`);
  const data = path.join(root, 'app');
  const home = path.join(root, 'native-home');
  const patch = path.join(root, 'dsh-fixture.json');
  const grant = path.join(home, '.credentials.yaml');
  const fixture = await modelFixture();
  await mkdir(home, { recursive: true });
  const saved = JSON.stringify({ version: 1, records: {
    'deepseek-account-platform/default': { kind: 'grant', payload: { version: 1, token: 'dsh_mock_wallet', issuer: fixture.origin } },
  } });
  await writeFile(grant, saved, { mode: 0o600 });
  await atomicJson(patch, [{ id: 'deepseek-account', config: { platformOrigin: fixture.origin, allowLoopbackHttp: true } }]);
  await atomicJson(path.join(data, 'settings.json'), {
    defaultWorkspace: home,
    deepseek: { home, authMode: 'native', args: ['@bundled/deepseek', '--profile', 'sdk', '--patch', patch] },
  });
  const desktop = await launchTauri({ ...process.env, ENTROTECT_DATA_DIR: data });
  try {
    const page = await desktop.firstWindow();
    await expect(page.getByRole('button', { name: '套餐与 API 余额' })).toHaveText('CNY 12.34');
    await page.getByRole('button', { name: '套餐与 API 余额' }).click();
    const details = page.getByRole('region', { name: '套餐与余额详情' });
    await expect(details.locator('.wallet-row strong')).toHaveText(['CNY 12.34', 'CNY 5.68']);
    expect(fixture.usageRequests).toContainEqual({ path: '/api/v0/users/get_user_summary', authorization: 'dsh_mock_wallet' });
    fixture.nativeAuthorized(false);
    await details.getByRole('button', { name: '刷新用量' }).click();
    await expect(details).toContainText('DeepSeek 未接受原生登录');
    expect(await readFile(grant, 'utf8')).toBe(saved);
    expect(await readdir(home)).toEqual(['.credentials.yaml']);
    expect(fixture.requests).toHaveLength(0);
  } finally {
    await desktop.close();
    await fixture.close();
  }
});
