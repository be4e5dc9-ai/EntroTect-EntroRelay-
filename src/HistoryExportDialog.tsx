import { useEffect, useState } from 'react';
import { ArrowUpRight, LoaderCircle, X } from 'lucide-react';
import { harnesses, type HistoryExportRules, type HistoryExportScope, type HistoryExportSelection } from '../shared/types';
import { harnessNames } from '../shared/harnesses';
import { api, message } from './api';
import { HarnessIcon } from './BrandIcon';
import './history.css';

export function HistoryExportDialog({ scope, title, onClose }: { scope: HistoryExportScope; title: string; onClose(): void }) {
  const [selection, setSelection] = useState<HistoryExportSelection>();
  const [rules, setRules] = useState<HistoryExportRules>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void api!.historyExportSelection(scope).then(value => {
      if (alive) { setSelection(value); setRules(value.rules); }
    }, error => { if (alive) setError(message(error)); });
    return () => { alive = false; };
  }, [scope]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [busy, onClose]);
  async function save() {
    setBusy(true); setError('');
    try { await api!.setHistoryExportSelection(scope, rules); onClose(); }
    catch (error) { setError(message(error)); setBusy(false); }
  }
  return <div className="modal-backdrop" onClick={() => { if (!busy) onClose(); }}>
    <section className="history-dialog history-scope-dialog" role="dialog" aria-label={scope.kind === 'project' ? '项目同步' : '对话同步'} onClick={event => event.stopPropagation()}>
      <header><div className="history-heading-icon"><ArrowUpRight size={20}/></div><div><h2>{scope.kind === 'project' ? '项目同步' : '对话同步'}</h2><p title={title}>{title}</p></div><button className="icon-button" aria-label="关闭同步设置" disabled={busy} onClick={onClose}><X size={18}/></button></header>
      <div className="history-body">
        <p className="history-help">{scope.kind === 'project' ? '设置整个项目的同步目标。对话可以单独覆盖项目设置。' : '为这条对话单独选择同步目标，或沿用项目设置。'}</p>
        {!selection && !error && <div className="history-empty"><LoaderCircle size={20} className="spin"/></div>}
        {selection && <>
          {!selection.enabled && <p className="history-help" role="status">自动导出已关闭。所选规则会在设置中重新开启自动导出后生效。</p>}
          <div className="history-targets">
            {harnesses.map(harness => <label key={harness} className="history-target">
              <span><HarnessIcon h={harness}/>{harnessNames[harness]}</span>
              <select aria-label={`${harnessNames[harness]} 同步规则`} disabled={busy} value={rules[harness] === undefined ? 'inherit' : rules[harness] ? 'on' : 'off'} onChange={event => {
                const value = event.target.value;
                setRules(old => { const next = { ...old }; if (value === 'inherit') delete next[harness]; else next[harness] = value === 'on'; return next; });
              }}>
                <option value="inherit">沿用{scope.kind === 'project' ? '默认' : '项目'} · {selection.inherited[harness] ? '同步' : '不同步'}</option>
                <option value="on">同步</option><option value="off">不同步</option>
              </select>
            </label>)}
          </div>
        </>}
        {error && <div className="history-error" role="alert">{error}</div>}
      </div>
      <footer><span>启用后，同步空闲对话与后续更新</span><button className="secondary-button" onClick={onClose} disabled={busy}>取消</button><button className="primary-button" onClick={() => void save()} disabled={!selection || busy}>{busy && <LoaderCircle className="spin" size={14}/>}保存同步范围</button></footer>
    </section>
  </div>;
}
