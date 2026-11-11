import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, CircleDashed, LoaderCircle, RefreshCw, Wallet } from 'lucide-react';
import type { AccountUsage, ContextUsage, Harness, SettingsView, WalletBalance } from '../shared/types';
import { api, message } from './api';
import { HarnessIcon } from './BrandIcon';

type UsageSnapshot = { data?: AccountUsage; loading?: boolean; error?: string };
export type UsageAccess = { read(harness: Harness): UsageSnapshot; request(harness: Harness, refresh?: boolean): void };

export function useAccountUsage(settings: SettingsView | undefined, activeHarness: Harness): UsageAccess {
  const [entries, setEntries] = useState<Partial<Record<Harness, UsageSnapshot & { settings: SettingsView }>>>({});
  const inFlight = useRef<Partial<Record<Harness, SettingsView>>>({});
  const request = useCallback((harness: Harness, refresh = false) => {
    if (!settings || !api || inFlight.current[harness] === settings) return;
    inFlight.current[harness] = settings;
    setEntries(old => ({ ...old, [harness]: { settings, loading: true, data: old[harness]?.settings === settings ? old[harness]?.data : undefined } }));
    function finish(value: UsageSnapshot) {
      if (inFlight.current[harness] !== settings) return;
      delete inFlight.current[harness];
      setEntries(old => ({ ...old, [harness]: { settings, data: old[harness]?.data, ...value } }));
    }
    void api.accountUsage(harness, refresh).then(data => finish({ data }), error => finish({ error: message(error) }));
  }, [settings]);
  useEffect(() => {
    const update = () => { if (document.visibilityState === 'visible') request(activeHarness); };
    const initial = setTimeout(update, 400);
    const interval = setInterval(update, 180_000);
    document.addEventListener('visibilitychange', update);
    return () => { clearTimeout(initial); clearInterval(interval); document.removeEventListener('visibilitychange', update); };
  }, [activeHarness, request]);
  return { read: harness => entries[harness]?.settings === settings ? entries[harness] ?? {} : {}, request };
}

const count = new Intl.NumberFormat('zh-CN');
const money = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percent = (value: number) => `${Math.floor(value)}%`;
const resetTime = (time: number) => new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function formatBalance({ currency, amount }: WalletBalance) {
  // Keep the validated decimal string through rounding, including half cents.
  return `${currency} ${money.format(amount as `${number}`)}`;
}

export function UsageDetails({ snapshot, harness, onRefresh, onSettings }: {
  snapshot: UsageSnapshot; harness: Harness; onRefresh(): void; onSettings?(): void;
}) {
  const { data, loading, error } = snapshot;
  const [linkError, setLinkError] = useState('');
  return <div className="usage-details">
    <header>
      <div><HarnessIcon h={harness}/><strong>{harnessNames[harness]} 用量</strong></div>
      <button className="icon-button" title="刷新用量" disabled={loading} onClick={onRefresh}><RefreshCw size={14} className={loading ? 'spin' : ''}/></button>
    </header>
    {loading && !data && <p className="usage-empty" role="status"><LoaderCircle className="spin" size={14}/>正在读取用量</p>}
    {error && <p className="usage-empty" role="status">{error}</p>}
    {!data && !loading && !error && <p className="usage-empty">点击刷新读取账户用量。</p>}
    {data && <>
      <section className="usage-group" aria-label="套餐用量">
        <h3>套餐用量</h3>
        {data.plan.status === 'ready' ? <>
          {data.plan.rows.map((row, index) => <div className="quota-row" key={`${row.name}-${index}`}>
            <div><span>{row.name}</span><strong>剩余 {percent(row.remainingPercent)}</strong></div>
            <progress value={row.remainingPercent} max={100} aria-label={`${row.name}剩余比例`}/>
            {row.resetAt && <small>{resetTime(row.resetAt)} 重置</small>}
          </div>)}
          <small>{data.plan.source}</small>
        </> : <p>{data.plan.detail}</p>}
      </section>
      <section className="usage-group" aria-label="账户余额">
        <h3>{data.authMode === 'native' && harness === 'deepseek' ? '账户余额' : 'API 余额'}</h3>
        {data.balance.status === 'ready' ? <>
          {!data.balance.rows.length && <p>当前账户没有可显示的余额条目。</p>}
          {data.balance.rows.map((row, index) => <div className="wallet-row" key={`${row.name}-${row.currency}-${index}`}>
            <span>{row.name}</span><strong>{formatBalance(row)}</strong>
          </div>)}
          <small>{data.balance.source}</small>
        </> : <p>{data.balance.detail}</p>}
      </section>
      <footer>
        <small>更新于 {new Date(data.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small>
        {data.consoleUrl && <button onClick={() => {
          setLinkError('');
          void api?.openLink(data.consoleUrl!).catch(error => setLinkError(message(error)));
        }}>供应商控制台<ArrowUpRight size={12}/></button>}
      </footer>
    </>}
    {linkError && <p className="form-error" role="alert">{linkError}</p>}
    {onSettings && <button className="usage-settings-link" onClick={onSettings}>用量设置<ArrowUpRight size={13}/></button>}
  </div>;
}

function ContextRing({ remaining }: { remaining: number | undefined }) {
  if (remaining === undefined) return <CircleDashed size={15}/>;
  return <svg className="context-ring" viewBox="0 0 18 18" width="15" height="15" aria-hidden="true">
    <circle cx="9" cy="9" r="6.4" fill="none" stroke="var(--border-strong)" strokeWidth="2"/>
    <circle cx="9" cy="9" r="6.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" pathLength="100"
      strokeDasharray={`${remaining} 100`} opacity={remaining > 0 ? 1 : 0} transform="rotate(-90 9 9)"/>
  </svg>;
}

export function ComposerUsage({ context, harness, usage, onSettings }: {
  context?: ContextUsage; harness: Harness; usage: UsageAccess; onSettings(): void;
}) {
  const [open, setOpen] = useState<'context' | 'usage'>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    function dismiss(event: Event) { if (!root.current?.contains(event.target as Node)) setOpen(undefined); }
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') { setOpen(undefined); trigger.current?.focus(); }
    }
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('focusin', dismiss);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('focusin', dismiss); window.removeEventListener('keydown', key); };
  }, [open]);
  const snapshot = usage.read(harness);
  const plan = snapshot.data?.plan;
  const balance = snapshot.data?.balance;
  const allowance = plan?.status === 'ready' ? plan.rows.find(row => row.name === '5 小时额度') ?? plan.rows[0] : undefined;
  const funds = balance?.status === 'ready' ? balance.rows[0] : undefined;
  const usageLabel = allowance ? `${allowance.name} ${percent(allowance.remainingPercent)}` : funds ? formatBalance(funds) : '用量';
  const remaining = context ? Math.max(0, context.windowTokens - context.usedTokens) : undefined;
  const remainingPercent = context && remaining !== undefined ? 100 * remaining / context.windowTokens : undefined;
  const contextTitle = remainingPercent !== undefined && context
    ? `上下文剩余 ${percent(remainingPercent)} · 已用 ${count.format(context.usedTokens)} / ${count.format(context.windowTokens)} tokens` : '剩余上下文';
  function toggle(panel: 'usage' | 'context', button: HTMLButtonElement) {
    trigger.current = button;
    setOpen(open === panel ? undefined : panel);
    if (panel === 'usage' && open !== panel) usage.request(harness);
  }
  return <div className="composer-usage" ref={root}>
    <button className="usage-chip" title={contextTitle} aria-label="剩余上下文" aria-expanded={open === 'context'} onClick={event => toggle('context', event.currentTarget)}>
      <ContextRing remaining={remainingPercent}/><span>{remainingPercent === undefined ? '上下文' : `上下文剩余 ${percent(remainingPercent)}`}</span>
    </button>
    <button className="usage-chip" title={usageLabel} aria-label="套餐与 API 余额" aria-expanded={open === 'usage'} onClick={event => toggle('usage', event.currentTarget)}>
      <Wallet size={14}/><span>{usageLabel}</span>
    </button>
    <section className="popover context-popover" aria-label="上下文用量详情" inert={open !== 'context'}>
      <header><strong>上下文窗口</strong><ContextRing remaining={remainingPercent}/></header>
      {context && remaining !== undefined ? <>
        <div className="context-remaining"><strong>{count.format(remaining)}</strong><span> tokens 剩余</span></div>
        <progress value={remaining} max={context.windowTokens} aria-label="剩余上下文比例"/>
        <p>已用 {count.format(context.usedTokens)} / {count.format(context.windowTokens)} tokens</p>
        <small>{context.source === 'reported' ? '依据最近一次请求返回的用量。' : '依据 Harness 当前会话的估算。'}</small>
      </> : <p>当前模型还没有可用的会话用量。收到 Harness 报告后会显示剩余上下文。</p>}
    </section>
    <section className="popover usage-popover" aria-label="套餐与余额详情" inert={open !== 'usage'}>
      <UsageDetails key={harness} snapshot={snapshot} harness={harness} onRefresh={() => usage.request(harness, true)} onSettings={() => { setOpen(undefined); onSettings(); }}/>
    </section>
  </div>;
}
import { harnessNames } from '../shared/harnesses';
