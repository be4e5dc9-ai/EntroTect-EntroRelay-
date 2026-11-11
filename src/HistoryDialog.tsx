import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, CheckCircle2, FolderOpen, LoaderCircle, MessageSquare, RefreshCw, Search, X } from 'lucide-react';
import { harnesses, type Conversation, type ExportReceipt, type Harness, type HistoryImportRule, type NativeHistory, type NativeHistorySource } from '../shared/types';
import { harnessNames as names } from '../shared/harnesses';
import { projectName } from '../shared/project-path';
import { api, message } from './api';
import { HarnessIcon } from './BrandIcon';
import './history.css';

export function HistoryDialog({ conversation, onClose, onImported }: { conversation?: Conversation; onClose(): void; onImported(c: Conversation): void }) {
  const exporting = !!conversation;
  const [harness, setHarness] = useState<Harness>(conversation?.harness || 'deepseek');
  const [sources, setSources] = useState<Record<Harness, NativeHistorySource> | null>(null);
  const [sessions, setSessions] = useState<NativeHistory[]>([]), [selected, setSelected] = useState(''), [search, setSearch] = useState('');
  const [workspace, setWorkspace] = useState(''), [error, setError] = useState(''), [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [receipt, setReceipt] = useState<ExportReceipt | null>(null);
  const ticket = useRef(0);
  const source = sources?.[harness], entry = sessions.find(s => s.id === selected);
  async function scan(value: NativeHistorySource, keepSelection = false) {
    const n = ++ticket.current; setLoading(true); setError(''); setWarnings([]);
    if (!keepSelection) { setSessions([]); setSelected(''); }
    try { const found = await api!.listHistory(value); if (ticket.current === n) { setSessions(found.sessions); setWarnings(found.warnings); } }
    catch (e) { if (ticket.current === n) setError(message(e)); }
    finally { if (ticket.current === n) setLoading(false); }
  }
  useEffect(() => { let alive = true; void api!.historyDefaults().then(values => { if (alive) { setSources(values); if (!exporting) void scan(values[harness]); } }, e => { if (alive) setError(message(e)); }); return () => { alive = false; ticket.current++; }; }, []);
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [busy, onClose]);
  function changeHarness(h: Harness) { setHarness(h); setReceipt(null); setWorkspace(''); setError(''); if (!exporting && sources) void scan(sources[h]); }
  function location(value: string) { if (!sources) return; ticket.current++; setLoading(false); setSources({ ...sources, [harness]: { harness, location: value } }); setSessions([]); setSelected(''); setReceipt(null); setWarnings([]); }
  async function chooseSource() { try { const value = harness === 'zcode' ? await api!.chooseDatabase() : await api!.chooseDirectory(); if (value) location(value); } catch (e) { setError(message(e)); } }
  async function submit() {
    if (!source) return; setBusy(true); setError('');
    try {
      if (exporting) setReceipt(await api!.exportHistory({ conversationId: conversation.id, target: source }));
      else { const c = await api!.importHistory({ source, sessionId: selected, workspace: workspace.trim() || undefined }); onImported(c); }
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function setRule(rule: HistoryImportRule) {
    setBusy(true); setError('');
    try {
      await api!.setHistoryImportRule(rule);
      await api!.syncHistory();
      await scan(rule.source, true);
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  const ruleValue = (value: boolean | undefined) => value === undefined ? 'inherit' : value ? 'on' : 'off';
  const ruleEnabled = (value: string) => value === 'inherit' ? null : value === 'on';
  return <div className="modal-backdrop" onClick={() => { if (!busy) onClose(); }}><section className="history-dialog" role="dialog" aria-label={exporting ? '在独立 Harness 中继续' : '导入历史对话'} onClick={e => e.stopPropagation()}>
    <header><div className="history-heading-icon">{exporting ? <ArrowUpRight size={20}/> : <ArrowDownToLine size={20}/>}</div><div><h2>{exporting ? '在独立 Harness 中继续' : '导入历史对话'}</h2><p>{exporting ? '选择用于续聊的 Harness 和数据目录' : '扫描本机的 Harness，选择要加入的对话或项目'}</p></div><button className="icon-button" title="关闭历史对话窗口" disabled={busy} onClick={onClose}><X size={18}/></button></header>
    <div className="history-body"><div className="history-harnesses" role="tablist" aria-label="历史来源">{harnesses.map(h => <button key={h} role="tab" aria-selected={harness === h} disabled={busy} onClick={() => changeHarness(h)}><HarnessIcon h={h}/>{names[h]}</button>)}</div>
      <label className="history-field"><span>{names[harness]} {harness === 'zcode' ? '会话数据库' : '数据目录'}</span><div><input aria-label="原生历史路径" value={source?.location || ''} disabled={busy || !sources} onChange={e => location(e.target.value)}/><button className="icon-button" title="选择原生历史路径" disabled={busy || !sources} onClick={() => void chooseSource()}><FolderOpen size={16}/></button>{!exporting && <button className="icon-button" title="读取历史对话" disabled={busy || loading || !source?.location.trim()} onClick={() => source && void scan(source)}><RefreshCw size={15} className={loading ? 'spin' : ''}/></button>}</div></label>
      {exporting ? <div className="history-export-summary"><MessageSquare size={18}/><div><strong>{conversation.title}</strong><span>{conversation.workspace}</span><small>{harness === 'codex' ? '目标目录已有此对话的当前 Codex 会话时，沿用原会话。' : '导出会创建可续聊的原生会话副本。'}</small></div></div> : <><label className="history-search"><Search size={15}/><input placeholder="搜索标题或项目目录" value={search} onChange={e => setSearch(e.target.value)} disabled={busy}/><span>{sessions.length}</span></label><div className="history-list" aria-label="原生历史对话">{loading ? <div className="history-empty"><LoaderCircle size={22} className="spin"/><p>正在读取本地历史…</p></div> : sessions.filter(s => `${s.title} ${s.workspace}`.toLowerCase().includes(search.toLowerCase())).map(s => <button key={s.id} className={selected === s.id ? 'selected' : ''} aria-pressed={selected === s.id} disabled={busy} onClick={() => { setSelected(s.id); setWorkspace(''); }}><MessageSquare size={16}/><div><strong>{s.title}</strong><span title={s.workspace}>{s.workspace || '原记录未保存项目目录'}</span><small>{s.sync?.joined ? '已加入 · ' : ''}{new Date(s.updatedAt).toLocaleString('zh-CN')} · {s.id}</small></div>{selected === s.id && <CheckCircle2 size={17}/>}</button>)}{!loading && !sessions.length && <div className="history-empty"><MessageSquare size={24}/><p>{error ? '请检查原生历史路径' : '此位置暂无历史对话'}</p><span>选择数据路径后点击右侧刷新按钮</span></div>}</div>
      {source && entry && <div className="history-targets">
        <label className="history-target"><span>此对话的自动导入</span><select aria-label="此对话的自动导入" disabled={busy} value={ruleValue(entry.sync?.session)} onChange={e => void setRule({ source, sessionId: entry.id, enabled: ruleEnabled(e.target.value) })}><option value="inherit">沿用默认或项目规则</option><option value="on">加入并同步</option><option value="off">忽略此对话</option></select></label>
        {/^(?:[a-z]:[\\/]|[\\/]{2}|\/)/i.test(entry.workspace) && <label className="history-target"><span title={entry.workspace}>整个项目 · {projectName(entry.workspace)}</span><select aria-label="整个项目的自动导入" disabled={busy} value={ruleValue(entry.sync?.project)} onChange={e => void setRule({ source, workspace: entry.workspace, enabled: ruleEnabled(e.target.value) })}><option value="inherit">沿用默认</option><option value="on">加入并同步整个项目</option><option value="off">忽略整个项目</option></select></label>}
        <small className="history-help">对话规则优先。忽略后停止导入更新，已加入的对话会保留。</small>
      </div>}
      <label className="history-field"><span>导入后的工作目录 <small>留空沿用原项目</small></span><div><input aria-label="导入工作目录" placeholder={entry?.workspace || '原目录不存在时，请选择一个目录'} value={workspace} disabled={busy} onChange={e => setWorkspace(e.target.value)}/><button className="icon-button" title="选择导入工作目录" disabled={busy} onClick={() => void api!.chooseDirectory().then(v => { if (v) setWorkspace(v); }).catch(e => setError(message(e)))}><FolderOpen size={16}/></button></div></label></>}
      {!!warnings.length && <details className="history-warnings"><summary>{warnings.length} 条记录暂时无法读取</summary>{warnings.map((w, i) => <p key={i}>{w}</p>)}</details>}
      {receipt && <div className="history-success" role="status"><CheckCircle2 size={19}/><div><strong>{receipt.reused ? '已找到原生 Codex 会话' : '已创建独立原生会话'}</strong><p>{receipt.sessionId}</p><p>{receipt.location}</p>{harness === 'codex' ? <span>在 Codex 桌面端打开对应会话，或在项目目录运行 <code>codex resume {receipt.sessionId}</code>。</span> : <span>在独立 {names[harness]} 中打开对应项目即可继续。已打开的桌面客户端可能需要重启以刷新列表。</span>}{receipt.backup && <small>原索引 / 数据库备份：{receipt.backup}</small>}</div></div>}
      {error && <div className="history-error" role="alert">{error}</div>}
    </div><footer><span>{busy ? '正在核对原生会话，请稍候…' : exporting ? '凭据沿用独立 Harness 的配置' : '导入对话记录，项目文件继续使用所选目录'}</span><button className="secondary-button" disabled={busy} onClick={onClose}>{receipt ? '完成' : '取消'}</button>{!receipt && <button className="primary-button" disabled={busy || loading || !source || (!exporting && !selected)} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" size={14}/> : exporting ? <ArrowUpRight size={14}/> : <ArrowDownToLine size={14}/>} {exporting ? harness === 'codex' ? '保存到 Codex' : '创建原生会话' : '导入对话'}</button>}</footer>
  </section></div>;
}
