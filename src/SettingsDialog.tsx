import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowUpRight, Check, FileText, FolderOpen, History, KeyRound, LoaderCircle, Monitor, RefreshCw, Settings2, Wallet } from 'lucide-react';
import { accentColors, defaultAccent, type AccentColor } from '../shared/appearance';
import { modelReasoning } from '../shared/reasoning';
import { activeRunStates, agentHarnesses, harnesses, type AppUpdateStatus, type ConnectionKeys, type Conversation, type Harness, type HarnessUpdates, type HarnessUpdateStatus, type HistorySyncStatus, type LaunchConfig, type ModelReasoning, type SettingsView, type Theme } from '../shared/types';
import { connectionFor, defaultModel, harnessNames, isAgentHarness, isHarness, nativeModel, supportsIsolatedLogin } from '../shared/harnesses';
import { api, message } from './api';
import { HarnessIcon } from './BrandIcon';
import { ReasoningSlider } from './ReasoningControl';
import { TokenActivity } from './TokenActivity';
import { UsageDetails, type UsageAccess } from './Usage';
import './preferences.css';

export type SettingsTab = 'general' | 'appearance' | 'usage' | 'history' | Harness;
const themes: { id: Theme; label: string; detail: string }[] = [
  { id: 'light', label: '月之亮面', detail: '浅色 · 默认' },
  { id: 'dark', label: '月之暗面', detail: '深色' },
  { id: 'system', label: '跟随系统', detail: '与 Windows 保持一致' },
];

function updateMessage(status?: HarnessUpdateStatus) {
  switch (status?.state) {
    case 'external': return '此连接使用自定义运行时。';
    case 'checking': return '正在检查官方发布…';
    case 'preparing': return `正在下载并验证 ${status.detail}…`;
    case 'ready': return `${status.pending} 已就绪，下次启动时启用。`;
    case 'current': return '已是最新版本。';
    case 'error': return '本次检查或更新未完成。';
    default: return '';
  }
}

function appUpdateMessage(update?: AppUpdateStatus, automatic = true) {
  switch (update?.state) {
    case 'portable': return '当前为解压版。使用 Windows 安装版可启用应用内更新。';
    case 'unconfigured': return '此安装版尚未绑定 GitHub 发布源。';
    case 'checking': return '正在检查 GitHub Releases…';
    case 'current': return '已是最新版本。';
    case 'downloading': return `正在下载 ${update.available}${update.total ? ` · ${Math.round((update.downloaded ?? 0) / update.total * 100)}%` : ''}…`;
    case 'ready': return `新版 ${update.available} 已验证。${automatic ? '退出应用时安装，也可现在重启。' : '可手动重启安装。'}`;
    case 'installing': return '正在退出应用并安装更新…';
    case 'error': return update.detail || '本次检查或安装未完成。';
    default: return '从 GitHub Releases 检查已签名的 Windows 安装包。';
  }
}

type SettingsProps = {
  settings: SettingsView;
  conversations: Conversation[];
  currentId?: string;
  initialTab: SettingsTab;
  currentHarness: Harness;
  usage: UsageAccess;
  appUpdate?: AppUpdateStatus;
  onShowUpdateLog(): void;
  onThemePreview(theme: Theme): void;
  onAccentPreview(accent: AccentColor): void;
  onClose(): void;
  onSaved(): Promise<void>;
  onImport(): void;
  onExport(id: string): void;
};

export function SettingsDialog({ settings, conversations, currentId, initialTab, currentHarness, usage, appUpdate, onShowUpdateLog, onThemePreview, onAccentPreview, onClose, onSaved, onImport, onExport }: SettingsProps) {
  const [value, setValue] = useState<SettingsView>(() => structuredClone(settings));
  const [tab, setTab] = useState(initialTab);
  const [keys, setKeys] = useState<ConnectionKeys>({});
  const [argsText, setArgsText] = useState(() => Object.fromEntries(harnesses.map(harness => [harness, JSON.stringify(connectionFor(settings, harness)?.args ?? [])])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loginStarted, setLoginStarted] = useState<Harness>();
  const [sync, setSync] = useState<HistorySyncStatus | null>(null);
  const [updates, setUpdates] = useState<HarnessUpdates>();
  const [installingApp, setInstallingApp] = useState(false);
  const [usageHarness, setUsageHarness] = useState(currentHarness);
  const [nativeReasoning, setNativeReasoning] = useState<ModelReasoning>();
  const [exportId, setExportId] = useState(() => conversations.find(chat => chat.id === currentId && chat.revision > 0)?.id || conversations.find(chat => chat.revision > 0)?.id || '');
  const h = isHarness(tab) ? tab : 'deepseek';
  const config = connectionFor(value, h);
  const hasKey = h === 'deepseek' ? settings.hasDeepseekKey : h === 'zcode' ? settings.hasZcodeKey : settings.hasAgentKeys?.[h];
  const preferences = { autoImport: true, autoExport: true, ...value.history };
  const startup = value.startup ?? { followLast: true, additional: [] };
  const autoUpdates = value.harnessUpdates;
  const model = defaultModel(value, h);
  const savedConfig = connectionFor(settings, h);
  const savedRoute = config?.model === savedConfig?.model && config?.executable === savedConfig?.executable && config?.home === savedConfig?.home && config?.authMode === savedConfig?.authMode && config?.isolatedNative === savedConfig?.isolatedNative && config?.provider === savedConfig?.provider && config?.baseUrl === savedConfig?.baseUrl;
  const capability = savedRoute && nativeReasoning?.harness === h && nativeReasoning.modelId === model ? nativeReasoning : modelReasoning(model, h);

  useEffect(() => {
    if (!isHarness(tab) || !isAgentHarness(tab) || !savedRoute || !api?.nativeModels) return;
    let active = true;
    void api.nativeModels({ harness: tab, workspace: settings.defaultWorkspace, modelId: model }).then(catalog => {
      if (active) setNativeReasoning(catalog.reasoning);
    }).catch(() => {});
    return () => { active = false; };
  }, [tab, savedRoute, model, settings.defaultWorkspace]);

  useEffect(() => {
    void api?.historySyncStatus().then(setSync).catch(error => setError(message(error)));
    void api?.harnessUpdateStatus().then(setUpdates).catch(error => setError(message(error)));
    return api?.onEvent(event => {
      if (event.type === 'history-sync') setSync(event.status);
      if (event.type === 'harness-updates') setUpdates(event.status);
    });
  }, []);
  useEffect(() => {
    if (tab === 'usage') usage.request(usageHarness);
  }, [tab, usageHarness, usage.request]);
  useEffect(() => {
    function close(event: KeyboardEvent) {
      if (event.key !== 'Escape' || busy || event.defaultPrevented) return;
      if (CSS.supports('selector(select:open)') && document.querySelector('.settings-modal select:open')) return;
      onClose();
    }
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [busy, onClose]);

  function field<K extends keyof LaunchConfig>(key: K, content: LaunchConfig[K]) {
    if (!config) return;
    const updated = { ...config, [key]: content };
    setValue(old => isAgentHarness(h) ? { ...old, agents: { ...old.agents, [h]: updated } } : { ...old, [h]: updated });
  }
  function setHistory(next: Partial<typeof preferences>) {
    setValue(old => ({ ...old, history: { ...preferences, ...next } }));
  }
  async function pick(request: () => Promise<string | null>, apply: (selected: string) => void) {
    try { const selected = await request(); if (selected) apply(selected); }
    catch (error) { setError(message(error)); }
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      const next = { ...value, agents: { ...value.agents } };
      for (const harness of harnesses) {
        const connection = connectionFor(value, harness);
        if (!connection) continue;
        const args = JSON.parse(argsText[harness]);
        if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error(`${harnessNames[harness]} 的启动参数必须是字符串组成的 JSON 数组`);
        if (isAgentHarness(harness)) next.agents[harness] = { ...connection, args };
        else next[harness] = { ...connection, args };
      }
      await api!.saveSettings(next, keys);
      await onSaved();
      onClose();
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  async function synchronize() {
    setBusy(true);
    setError('');
    try { setSync(await api!.syncHistory()); await onSaved(); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  async function installUpdate() {
    setInstallingApp(true);
    setError('');
    try { await api!.installAppUpdate(); }
    catch (error) { setError(message(error)); setInstallingApp(false); }
  }
  const canCheckApp = appUpdate && !['portable', 'unconfigured', 'checking', 'downloading', 'ready', 'installing'].includes(appUpdate.state);
  const runningTasks = conversations.some(chat => activeRunStates.has(chat.state));
  const nav = (id: SettingsTab, label: string, icon: React.ReactNode) => <button key={id} className={id === tab ? 'selected' : ''} aria-current={id === tab ? 'page' : undefined}
    onClick={() => { setTab(id); setError(''); }}>{icon}{label}</button>;

  return <section className="settings-modal" role="dialog" aria-modal="true" aria-label="设置与连接">
    <aside className="settings-rail">
      <button className="settings-back" title="关闭设置" disabled={busy} onClick={onClose}><ArrowLeft size={16}/>返回工作区</button>
      <h1>设置</h1>
      <nav aria-label="设置导航">
        {nav('general', '通用', <Settings2 size={17}/>)}
        {nav('appearance', '外观', <Monitor size={17}/>)}
        {nav('usage', '用量', <Wallet size={17}/>)}
        {nav('history', '历史与同步', <History size={17}/>)}
        <span className="section-label">Harness 连接</span>
        {nav('deepseek', 'DeepSeek', <HarnessIcon h="deepseek"/>)}
        {nav('zcode', 'GLM / ZCode', <HarnessIcon h="zcode"/>)}
        {agentHarnesses.map(harness => nav(harness, harnessNames[harness], <HarnessIcon h={harness}/>))}
      </nav>
    </aside>
    <div className="settings-main">
      <div className="settings-scroll" key={tab}><div className="settings-fields">
        {tab === 'general' && <>
          <h2>通用</h2><p className="settings-description">管理新对话的工作目录和常用快捷键。</p>
          <section className="settings-card">
            <label className="form-field">默认工作目录<div className="path-input">
              <input value={value.defaultWorkspace} onChange={event => setValue(old => ({ ...old, defaultWorkspace: event.target.value }))}/>
              <button className="secondary-button" onClick={() => void pick(api!.chooseDirectory, defaultWorkspace => setValue(old => ({ ...old, defaultWorkspace })))}><FolderOpen size={15}/>选择</button>
            </div></label>
            <small>启动后，新对话默认使用这个目录。已保存对话仍在原项目中。</small>
          </section>
          <h3 className="settings-section-title">EntroTect 更新</h3>
          <div className="settings-card">
            <div className="preference-switch-row">
              <div><strong>自动更新 EntroTect</strong><p>启动后在后台检查和下载，退出应用时安装已验证的更新。</p></div>
              <button role="switch" aria-label="自动更新 EntroTect" aria-checked={value.autoAppUpdate !== false} className="preference-switch"
                onClick={() => setValue(old => ({ ...old, autoAppUpdate: old.autoAppUpdate === false }))}><span/></button>
            </div>
            <div className="preference-switch-row">
              <div role="status" aria-label="应用更新状态"><strong>版本 {appUpdate?.version ?? '…'}</strong><p>{appUpdateMessage(appUpdate, settings.autoAppUpdate !== false)}</p></div>
              <div className="app-update-settings-actions">
                <button className="secondary-button" onClick={onShowUpdateLog}><FileText size={14}/>查看更新日志</button>
                {appUpdate?.state === 'ready' ? <button className="secondary-button" disabled={busy || installingApp || runningTasks} title={runningTasks ? '等待当前任务结束' : undefined}
                  onClick={() => void installUpdate()}><RefreshCw size={14}/>重启并更新</button>
                  : <button className="secondary-button" disabled={!canCheckApp || busy} onClick={() => void api!.checkAppUpdate().catch(error => setError(message(error)))}><RefreshCw size={14}/>检查应用更新</button>}
              </div>
            </div>
          </div>
          <h3 className="settings-section-title">Harness 启动</h3>
          <div className="settings-card">
            <div className="preference-switch-row">
              <div><strong>启动上次使用的 Harness</strong><p>打开应用时，在后台预热上次使用的执行器，并恢复上次打开的对话。</p></div>
              <button role="switch" aria-label="启动上次使用的 Harness" aria-checked={startup.followLast} className="preference-switch"
                onClick={() => setValue(old => ({ ...old, startup: { ...startup, followLast: !startup.followLast } }))}><span/></button>
            </div>
            {harnesses.map(harness => {
              const name = harnessNames[harness];
              const enabled = startup.additional.includes(harness);
              const standalone = harness === 'zcode' && value.zcode.authMode === 'native';
              return <div className="preference-switch-row" key={harness}>
                <div><strong>随应用启动 {name}</strong><p>{standalone ? 'ZCode 原生登录按条启动。使用 API Key 连接时支持后台预热。' : '每次打开应用都在后台预热此执行器。'}</p></div>
                <button role="switch" aria-label={'随应用启动 ' + name} aria-checked={enabled} disabled={standalone && !enabled} className="preference-switch"
                  onClick={() => setValue(old => ({ ...old, startup: { ...startup, additional: enabled ? startup.additional.filter(item => item !== harness) : [...startup.additional, harness] } }))}><span/></button>
              </div>;
            })}
          </div>
          <h3 className="settings-section-title">Harness 更新</h3>
          <div className="settings-card">
            {harnesses.map(harness => {
              const name = harnessNames[harness];
              const status = updates?.[harness];
              const detail = updateMessage(status);
              const enabled = autoUpdates?.[harness] !== false;
              return <div className="preference-switch-row" key={harness}>
                <div><strong>自动更新 {name}</strong><p title={status?.state === 'error' ? status.detail : undefined}>
                  {status?.version ? `当前版本 ${status.version}。` : ''}{detail || '新版准备好后将在下次启动时启用。'}
                </p></div>
                <button role="switch" aria-label={'自动更新 ' + name} aria-checked={enabled} className="preference-switch"
                  disabled={status?.state === 'external'} onClick={() => setValue(old => ({ ...old, harnessUpdates: { ...autoUpdates, [harness]: !enabled } }))}><span/></button>
              </div>;
            })}
            <div className="preference-switch-row">
              <div><strong>检查更新</strong><p>使用已保存的自动更新设置。</p></div>
              <button className="secondary-button" disabled={busy || !harnesses.some(harness =>
                settings.harnessUpdates?.[harness] !== false && !['external', 'checking', 'preparing', 'ready'].includes(updates?.[harness]?.state ?? 'idle'))}
                onClick={() => void api!.checkHarnessUpdates().then(setUpdates).catch(error => setError(message(error)))}><RefreshCw size={14}/>立即检查</button>
            </div>
          </div>
          <h3 className="settings-section-title">键盘快捷键</h3>
          <div className="settings-card shortcut-list">
            <div><span>新对话</span><kbd>Ctrl + N</kbd></div>
            <div><span>发送任务</span><kbd>Enter</kbd></div>
            <div><span>输入换行</span><kbd>Shift + Enter</kbd></div>
            <div><span>浏览 Harness 命令</span><kbd>/</kbd></div>
          </div>
        </>}
        {tab === 'appearance' && <>
          <h2>外观</h2><p className="settings-description">主题和强调色即时预览，保存后应用。</p>
          <div className="theme-options" role="group" aria-label="主题">
            {themes.map(theme => <button key={theme.id} className="theme-option" aria-pressed={(value.theme ?? 'light') === theme.id}
              onClick={() => { setValue(old => ({ ...old, theme: theme.id })); onThemePreview(theme.id); }}>
              <div className={`theme-sample sample-${theme.id}`} aria-hidden="true"><i/><div><i/><i/><b/></div></div>
              <div><strong>{theme.label}</strong><small>{theme.detail}</small></div>
              {(value.theme ?? 'light') === theme.id && <Check className="theme-check" size={15}/>}
            </button>)}
          </div>
          <section className="settings-card accent-settings" aria-labelledby="accent-title">
            <h3 id="accent-title">强调色</h3>
            <div className="accent-options" role="group" aria-label="强调色">
              {(Object.keys(accentColors) as AccentColor[]).map(id => {
                const accent = accentColors[id];
                const selected = (value.accentColor ?? defaultAccent) === id;
                return <button type="button" key={id} className="accent-option" aria-pressed={selected}
                  onClick={() => { setValue(old => ({ ...old, accentColor: id })); onAccentPreview(id); }}>
                  <span className="accent-swatch" style={{ backgroundColor: accent.wash, color: accent.lightInk }} aria-hidden="true">
                    {selected ? <Check size={13}/> : <span/>}
                  </span>
                  {accent.label}
                </button>;
              })}
            </div>
          </section>
        </>}
        {tab === 'usage' && <>
          <h2>用量</h2><p className="settings-description">查看当前连接的套餐额度与账户余额。查询用量不会发送模型任务。</p>
          <TokenActivity/>
          <div className="segmented usage-tabs" aria-label="用量来源">
            {harnesses.map(harness => <button key={harness} aria-pressed={usageHarness === harness} onClick={() => setUsageHarness(harness)}><HarnessIcon h={harness}/>{harness === 'deepseek' ? 'DeepSeek' : harness === 'zcode' ? 'GLM / ZCode' : harnessNames[harness]}</button>)}
          </div>
          <section className="settings-card settings-usage"><UsageDetails key={usageHarness} snapshot={usage.read(usageHarness)} harness={usageHarness} onRefresh={() => usage.request(usageHarness, true)}/></section>
          {usageHarness === 'zcode' && <section className="settings-card quota-settings">
            <h3>Coding Plan 查询</h3><p>使用官方 Coding Plan API 时可复用连接密钥。使用原生登录时可单独添加查询密钥。</p>
            <div className="form-row"><label className="form-field">查询区域<select value={value.quotaRegion ?? 'auto'} onChange={event => setValue(old => ({ ...old, quotaRegion: event.target.value as SettingsView['quotaRegion'] }))}>
              <option value="auto">根据连接地址识别</option><option value="zai">Z.ai 国际版</option><option value="bigmodel">智谱开放平台</option>
            </select></label>
            <label className="form-field">Coding Plan 查询密钥<div className="input-icon"><KeyRound size={14}/><input type="password" autoComplete="off" value={keys.zcodeUsage ?? ''} onChange={event => setKeys(old => ({ ...old, zcodeUsage: event.target.value }))}
              placeholder={keys.zcodeUsage === null ? '保存后移除' : settings.hasZcodeUsageKey ? '已保存 · 留空保留' : '选填'}/></div></label></div>
            {settings.hasZcodeUsageKey && <button className="secondary-button" onClick={() => setKeys(old => ({ ...old, zcodeUsage: old.zcodeUsage === null ? undefined : null }))}>{keys.zcodeUsage === null ? '撤销移除' : '移除查询密钥'}</button>}
          </section>}
        </>}
        {tab === 'history' && <>
          <h2>历史与同步</h2><p className="settings-description">扫描独立 Harness 的历史，并按对话或项目的规则同步。</p>
          <div className="settings-card">
            <div className="preference-switch-row"><div><strong>自动导入历史对话</strong><p>在「导入历史」中选择对话或项目。</p></div><button role="switch" aria-label="自动导入历史对话" aria-checked={preferences.autoImport} className="preference-switch" onClick={() => setHistory({ autoImport: !preferences.autoImport })}><span/></button></div>
            <div className="preference-switch-row"><div><strong>自动导出对话</strong><p>在项目或对话菜单中选择目标 Harness。</p></div><button role="switch" aria-label="自动导出对话" aria-checked={preferences.autoExport} className="preference-switch" onClick={() => setHistory({ autoExport: !preferences.autoExport })}><span/></button></div>
            <div className="form-row">
              <label className="form-field">默认导入范围<select value={preferences.importScope ?? 'selected'} onChange={event => setHistory({ importScope: event.target.value === 'all' ? 'all' : 'selected' })}><option value="selected">已选择或已加入的对话</option><option value="all">所有扫描到的对话</option></select></label>
              <label className="form-field">默认导出范围<select value={preferences.exportScope ?? 'selected'} onChange={event => setHistory({ exportScope: event.target.value === 'all' ? 'all' : 'selected' })}><option value="selected">已选择的目标</option><option value="all">所有已配置的目标</option></select></label>
            </div>
            <p className="settings-info">两端同时新增内容时保留分支。独立客户端打开时暂缓写回，退出后继续。</p>
            <details className="advanced-settings"><summary>同步数据路径</summary>{harnesses.map(source => <label className="form-field" key={source}>{harnessNames[source]} {source === 'zcode' ? '数据库' : '数据目录'}<div className="path-input"><input aria-label={`${source} 同步路径`} value={preferences.sources?.[source] ?? ''} placeholder="留空使用原生路径"
              onChange={event => setHistory({ sources: { ...preferences.sources, [source]: event.target.value } })}/><button className="icon-button" title={`选择 ${source} 同步路径`}
              onClick={() => void pick(source === 'zcode' ? api!.chooseDatabase : api!.chooseDirectory, location => setHistory({ sources: { ...preferences.sources, [source]: location } }))}><FolderOpen size={15}/></button></div></label>)}</details>
          </div>
          <div className="settings-card preference-sync-status" role="status" aria-label="历史同步状态">
            <div>{sync?.running ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>}<strong>{sync?.running ? '正在后台同步' : sync?.lastSyncAt ? `上次检查 ${new Date(sync.lastSyncAt).toLocaleTimeString('zh-CN')}` : '等待后台检查'}</strong>
              <button className="secondary-button" title="立即同步历史" disabled={busy || sync?.running || (!preferences.autoImport && !preferences.autoExport)} onClick={() => void synchronize()}><RefreshCw size={13}/>立即同步</button></div>
            {!!sync?.issues.length && <details><summary>{sync.issues.length} 项暂未同步</summary>{sync.issues.map((issue, index) => <p key={index}>{issue}</p>)}</details>}
          </div>
          <div className="settings-card preference-manual"><h3>手动操作</h3><button className="secondary-button" disabled={busy} onClick={onImport}><ArrowDownToLine size={14}/>手动导入历史</button>
            <label className="form-field">导出的对话<select aria-label="手动导出对话" value={exportId} onChange={event => setExportId(event.target.value)}><option value="">选择一条对话</option>{conversations.filter(chat => chat.revision > 0).map(chat => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</select></label>
            <button className="secondary-button" disabled={busy || !exportId} onClick={() => onExport(exportId)}><ArrowUpRight size={14}/>手动导出续聊</button>
          </div>
        </>}
        {isHarness(tab) && config && <>
          <h2>{harnessNames[h]}</h2><p className="settings-description">配置模型、连接方式及原生数据目录。</p>
          <section className="settings-card connection-form">
            <div className="segmented" aria-label="连接方式"><button aria-pressed={config.authMode === 'native'} onClick={() => field('authMode', 'native')}>复用原生登录</button><button aria-pressed={config.authMode === 'api'} onClick={() => field('authMode', 'api')}>使用 API Key</button></div>
            {config.authMode === 'native' ? <>
              <p className="settings-info">{config.isolatedNative && supportsIsolatedLogin(h) ? '在应用专用目录登录套餐账号。对话由历史同步导入和写回独立端。' :
                `请先在对应 Harness 中登录。${h === 'zcode' ? 'ZCode 从数据基目录下的 .zcode 文件夹读取登录。' : supportsIsolatedLogin(h) ? '此连接与独立端共用原生会话目录。' : ''}`}</p>
              {supportsIsolatedLogin(h) && <div className="isolated-login">
                <div className="preference-switch-row">
                  <div><strong>在 EntroTect 中独立登录</strong><p>分别保存套餐登录和运行中的会话。</p></div>
                  <button type="button" role="switch" className="preference-switch" aria-label="在 EntroTect 中独立登录"
                    aria-checked={!!config.isolatedNative} onClick={() => { setLoginStarted(undefined); field('isolatedNative', !config.isolatedNative); }}><span/></button>
                </div>
                {config.isolatedNative && <div className="settings-card-title">
                  <small role="status">{loginStarted === h ? '请在登录窗口完成操作。' : savedRoute ? '在弹出的终端中完成官方登录。' : '保存连接后可在这里启动登录。'}</small>
                  <button className="secondary-button" disabled={busy || !savedRoute} onClick={() => {
                    setError('');
                    void api!.launchAgentLogin(h).then(() => setLoginStarted(h)).catch(error => setError(message(error)));
                  }}><ArrowUpRight size={14}/>打开登录</button>
                </div>}
              </div>}
            </> : <>
              <label className="form-field">API Key<div className="input-icon"><KeyRound size={14}/><input type="password" autoComplete="off" value={keys[h] ?? ''} onChange={event => setKeys(old => ({ ...old, [h]: event.target.value }))} placeholder={hasKey ? '已保存 · 留空保持现有 Key' : '输入 API Key'}/></div></label>
              <label className="form-field">API 地址<input value={config.baseUrl} onChange={event => field('baseUrl', event.target.value)}/></label>
            </>}
            <div className="form-row">
              {h !== 'codex' && h !== 'kimi' && <label className="form-field">Provider ID<input value={config.provider} onChange={event => field('provider', event.target.value)} placeholder={h === 'deepseek' ? 'deepseek-account / deepseek-official' : '留空跟随原生配置'}/></label>}
              <label className="form-field">模型 ID<input value={config.model} onChange={event => field('model', event.target.value)} placeholder={nativeModel(defaultModel(undefined, h)) ?? '留空使用原生默认模型'}/></label>
            </div>
            <label className="form-field">{h === 'zcode' ? '数据基目录（其下读取 .zcode）' : config.isolatedNative && config.authMode === 'native' ? '独立端数据目录' : '原生数据目录'}<input value={config.home} onChange={event => field('home', event.target.value)}/></label>
          </section>
          <section className="settings-card connection-form">
            <div className="settings-card-title"><h3>默认思考强度</h3>{capability.sourceUrl && <button className="text-button" onClick={() => void api!.openLink(capability.sourceUrl!).catch(error => setError(message(error)))}>档位来源<ArrowUpRight size={13}/></button>}</div>
            {capability.levels.length ? <>
              <ReasoningSlider levels={capability.levels} label="默认思考强度" value={capability.levels.find(level => level.nativeValue === config.reasoning)?.id ?? ''}
                onChange={id => field('reasoning', capability.levels.find(level => level.id === id)?.nativeValue ?? '')}/>
              <small>auto 使用 Harness 默认值。对话内仍可单独设置。</small>
            </> : <p className="settings-info">暂无此模型已核实的思考档位，将使用 Harness 默认值。</p>}
          </section>
          <details className="settings-card advanced-settings"><summary>运行时与高级设置</summary>
            <label className="form-field">启动程序<div className="path-input"><input value={config.executable} onChange={event => field('executable', event.target.value)}/><button className="icon-button" title="选择启动程序" onClick={() => void pick(api!.chooseExecutable, file => field('executable', file))}><FolderOpen size={15}/></button></div></label>
            <label className="form-field">启动参数（JSON 数组）<textarea rows={3} value={argsText[h]} onChange={event => setArgsText(old => ({ ...old, [h]: event.target.value }))}/></label>
          </details>
        </>}
      </div></div>
      <footer className="settings-footer">
        {error ? <span className="form-error" role="alert">{error}</span> : <span>{isHarness(tab) ? 'API Key 由 Windows 加密保存。' : tab === 'history' ? '保存后应用同步开关。' : ''}</span>}
        <button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
        <button className="primary-button" disabled={busy} onClick={() => void save()}>{busy ? <LoaderCircle size={14} className="spin"/> : <Check size={14}/>} {isHarness(tab) ? '保存连接' : '保存设置'}</button>
      </footer>
    </div>
  </section>;
}
