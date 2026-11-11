import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { compareRuntimeVersions, isRuntimeVersion, verifyRuntime, type RuntimeSource } from '../backend/runtime-release';
import { RuntimeUpdates } from '../backend/runtime-updates';
import { bundledRuntimeKey, defaultAgentConnection, harnessEntry, SettingsStore } from '../backend/settings';
import { atomicJson } from '../backend/store';
import { agentHarnesses, harnesses, type Harness, type HarnessUpdateStatus } from '../shared/types';

test('release versions reject unsafe paths and follow prerelease ordering', () => {
  assert(!isRuntimeVersion('3.18.0/../../other-app'));
  assert(compareRuntimeVersions('0.2.2-rc.10', '0.2.2-rc.9') > 0);
  assert(compareRuntimeVersions('0.2.2', '0.2.2-rc.10') > 0);
  assert(compareRuntimeVersions('3.17.2', '3.18.0') < 0);
});

test('bundled harnesses pass the offline upgrade compatibility checks', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'entrotect-update-probe-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }));
  const runtime = path.resolve('.runtime');
  const node = path.join(runtime, 'node', 'node.exe');
  await Promise.allSettled(harnesses.map(harness => verifyRuntime(harness, node,
    path.join(runtime, bundledRuntimeKey(harness)), path.join(root, harness), t.signal))).then(results => {
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
});

test('updates stage independently, activate on restart and remove superseded versions', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'entrotect-update-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'bundled');
  await atomicJson(path.join(runtime, 'versions.json'), { dsh: '0.2.2-rc.1', zcode: '3.17.2' });
  const external = path.join(root, 'separate-zcode.cjs');
  await writeFile(external, 'standalone installation');
  const installed = path.join(root, 'harness-runtimes', 'deepseek');
  const release: Partial<Record<Harness, string>> = { deepseek: '0.2.2-rc.2', zcode: '3.17.3' };
  const disableNew = { kimi: false, opencode: false, codex: false };
  const checks: Harness[] = [];
  let incompatible = true;
  const source: RuntimeSource = {
    async latest(harness) {
      checks.push(harness);
      return { version: release[harness]! };
    },
    async prepare(harness, candidate, scratch) {
      const entry = harnessEntry(harness, path.join(scratch, 'runtime'));
      await mkdir(path.dirname(entry), { recursive: true });
      await writeFile(entry, candidate.version);
      if (harness === 'deepseek' && incompatible) throw new Error('incompatible protocol');
    },
  };
  const crypto = { protect: async (value: string) => value, unprotect: async (value: string) => value };
  async function open() {
    const settings = new SettingsStore(root, runtime, process.execPath, crypto);
    await settings.init();
    const updates = new RuntimeUpdates(settings, () => {}, source);
    await updates.init();
    return { settings, updates };
  }
  async function expectState(updates: RuntimeUpdates, state: HarnessUpdateStatus['state']) {
    const deadline = Date.now() + 5_000;
    while (updates.status.deepseek.state !== state && Date.now() < deadline) await setTimeout(20);
    assert.equal(updates.status.deepseek.state, state, updates.status.deepseek.detail);
  }

  let { settings, updates } = await open();
  assert.deepEqual(settings.value.harnessUpdates, { deepseek: true, zcode: true, kimi: true, opencode: true, codex: true });
  const original = settings.value.deepseek.args[0];
  await settings.save({ ...settings.value, zcode: { ...settings.value.zcode, args: [external] }, harnessUpdates: { ...disableNew } });
  updates.check();
  await expectState(updates, 'error');
  assert.equal(settings.value.deepseek.args[0], original);
  assert.deepEqual(await readdir(installed), []);
  assert.equal(updates.status.zcode.state, 'external');
  assert.deepEqual(checks, ['deepseek']);

  incompatible = false;
  updates.check();
  await expectState(updates, 'ready');
  assert.equal(settings.value.deepseek.args[0], original);
  await settings.save({ ...settings.value, harnessUpdates: { ...disableNew, deepseek: false, zcode: true } });
  updates.preferencesChanged();
  await updates.stop();

  ({ settings, updates } = await open());
  assert.equal(settings.value.harnessUpdates?.deepseek, false);
  assert.equal(settings.value.deepseek.args[0], original);
  assert.deepEqual(await readdir(installed), ['versions.json']);
  const checksWhileDisabled = checks.length;
  updates.check();
  assert.equal(checks.length, checksWhileDisabled);
  await settings.save({ ...settings.value, harnessUpdates: { ...disableNew, deepseek: true, zcode: true } });
  updates.preferencesChanged();
  await expectState(updates, 'ready');
  await updates.stop();

  ({ settings, updates } = await open());
  assert.equal(updates.status.deepseek.version, '0.2.2-rc.2');
  assert.equal(await readFile(settings.value.deepseek.args[0], 'utf8'), '0.2.2-rc.2');
  assert(settings.usesBundledLauncher('deepseek'));
  await settings.save(settings.value);
  assert.equal(JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')).deepseek.args[0], '@bundled/deepseek');

  release.deepseek = '0.2.2-rc.3';
  updates.check();
  await expectState(updates, 'ready');
  assert.equal(await readFile(settings.value.deepseek.args[0], 'utf8'), '0.2.2-rc.2');
  await updates.stop();
  ({ settings, updates } = await open());
  assert.equal(await readFile(settings.value.deepseek.args[0], 'utf8'), '0.2.2-rc.3');
  assert.deepEqual((await readdir(installed)).sort(), ['0.2.2-rc.3', 'versions.json']);
  assert.equal(await readFile(external, 'utf8'), 'standalone installation');
  release.deepseek = '0.2.2-rc.2';
  updates.check();
  await expectState(updates, 'current');
  await updates.stop();
});

test('bundled CLIs start offline, supersede older downloads and stage newer updates', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'entrotect-agent-updates-'));
  const previousPath = process.env.PATH;
  process.env.PATH = root;
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }));
  const runtime = path.join(root, 'bundled');
  const base = '1.2.2';
  await atomicJson(path.join(runtime, 'versions.json'), { dsh: '0.2.2-rc.1', zcode: '3.17.2', kimi: base, opencode: base, codex: base });
  for (const harness of agentHarnesses) {
    const entry = harnessEntry(harness, path.join(runtime, harness));
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, base);
    const previous = path.join(root, 'harness-runtimes', harness);
    const download = harnessEntry(harness, path.join(previous, base));
    await mkdir(path.dirname(download), { recursive: true });
    await writeFile(download, 'downloaded by previous release');
    await atomicJson(path.join(previous, 'versions.json'), harness === 'codex' ? { active: base } : { pending: base });
  }
  const external = path.join(root, 'outside-codex.exe');
  await writeFile(external, 'unchanged');
  const installedOpenCode = path.join(root, 'opencode.exe');
  await writeFile(installedOpenCode, 'independent CLI on PATH');
  let version = base;
  const prepared: Harness[] = [];
  const source: RuntimeSource = {
    async latest() { return { version }; },
    async prepare(harness, candidate, scratch) {
      prepared.push(harness);
      const file = harnessEntry(harness, path.join(scratch, 'runtime'));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, candidate.version);
    },
  };
  const crypto = { protect: async (value: string) => value, unprotect: async (value: string) => value };
  async function start() {
    const settings = new SettingsStore(root, runtime, process.execPath, crypto);
    await settings.init();
    const updates = new RuntimeUpdates(settings, () => {}, source);
    await updates.init();
    return { settings, updates };
  }
  async function check(updates: RuntimeUpdates, state: HarnessUpdateStatus['state']) {
    updates.check();
    const deadline = Date.now() + 5_000;
    while (agentHarnesses.some(harness => updates.status[harness].state !== state) && Date.now() < deadline) await setTimeout(20);
    for (const harness of agentHarnesses) assert.equal(updates.status[harness].state, state, updates.status[harness].detail);
  }
  let { settings, updates } = await start();
  await settings.save({ ...settings.value, harnessUpdates: { deepseek: false, zcode: false } });
  for (const harness of agentHarnesses) {
    assert.equal(updates.status[harness].version, base);
    assert.equal(updates.status[harness].pending, undefined);
    assert.equal(await settings.agentExecutable(harness), harnessEntry(harness, path.join(runtime, harness)));
    assert.deepEqual(await readdir(path.join(root, 'harness-runtimes', harness)), ['versions.json']);
  }
  await check(updates, 'current');
  assert.deepEqual(prepared, []);
  version = '1.2.3';
  await check(updates, 'ready');
  for (const harness of agentHarnesses) {
    assert.equal(updates.status[harness].pending, version);
    assert.equal(await readFile((await settings.agentExecutable(harness))!, 'utf8'), base);
  }
  await updates.stop();

  ({ settings, updates } = await start());
  for (const harness of agentHarnesses) {
    assert.equal(updates.status[harness].version, '1.2.3');
    assert.equal(await readFile((await settings.agentExecutable(harness))!, 'utf8'), '1.2.3');
    assert.equal(settings.value.agents![harness]!.executable, defaultAgentConnection(harness).executable);
  }
  version = '1.2.4';
  await check(updates, 'ready');
  await updates.stop();
  ({ settings, updates } = await start());
  for (const harness of agentHarnesses) {
    assert.equal(await readFile((await settings.agentExecutable(harness))!, 'utf8'), '1.2.4');
    assert.deepEqual((await readdir(path.join(root, 'harness-runtimes', harness))).sort(), ['1.2.4', 'versions.json']);
  }
  await settings.save({ ...settings.value, agents: { ...settings.value.agents, codex: { ...defaultAgentConnection('codex'), executable: external } } });
  assert.equal(updates.status.codex.state, 'external');
  assert.equal(await settings.agentExecutable('codex'), external);
  assert.equal(await readFile(external, 'utf8'), 'unchanged');
  assert.equal(await readFile(installedOpenCode, 'utf8'), 'independent CLI on PATH');
  await updates.stop();
});
