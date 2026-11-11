import { memo, useEffect, useRef } from 'react';
import { ArrowDownToLine, ChevronRight, CircleAlert, FileText, PackageCheck, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AppUpdateStatus } from '../shared/types';
import changelog from '../CHANGELOG.md?raw';
import { api } from './api';
import './app-update.css';

const titles = {
  downloading: '正在下载更新',
  ready: '更新已就绪',
  installing: '正在安装更新',
  error: '更新暂未完成',
} as const;

export function AppUpdateReminder({ update, compact, onOpen }: { update?: AppUpdateStatus; compact?: boolean; onOpen(): void }) {
  if (!update?.available || !(update.state in titles)) return null;
  const title = titles[update.state as keyof typeof titles];
  const progress = update.state === 'downloading' && update.total && update.total > 0
    ? Math.min(100, Math.max(0, Math.round((update.downloaded ?? 0) / update.total * 100))) : undefined;
  const detail = `v${update.available}${progress !== undefined ? ` · ${progress}%` : ''}`;
  const Icon = update.state === 'ready' ? PackageCheck : update.state === 'error' ? CircleAlert : ArrowDownToLine;
  return <button type="button" className={compact ? 'rail-button update-rail-button' : 'app-update-reminder'}
    aria-label={`${title}，${detail}，查看更新日志`} title={`${title} · ${detail}`} onClick={onOpen}>
    <Icon size={compact ? 18 : 16} aria-hidden="true"/>
    {!compact && <>
      <span className="update-reminder-copy"><strong>{title}</strong><small>{detail}</small>
        {progress !== undefined && <span className="update-reminder-track" aria-hidden="true"><span style={{ width: `${progress}%` }}/></span>}
      </span>
      <ChevronRight size={14} aria-hidden="true"/>
    </>}
  </button>;
}

const ReleaseMarkdown = memo(function ReleaseMarkdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']} components={{
    a: ({ href, children }) => href?.startsWith('https://')
      ? <a href={href} onClick={event => {
        event.preventDefault();
        void api?.openLink(href).catch(() => {});
      }}>{children}</a>
      : <span>{children}</span>,
  }}>{text}</ReactMarkdown>;
});

export function AppUpdateLog({ update, onClose }: { update?: AppUpdateStatus; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  const available = update?.available;
  return <dialog ref={dialog} className="app-update-log" aria-labelledby="app-update-log-title"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section>
      <header className="dialog-header">
        <div><FileText size={18}/><h2 id="app-update-log-title">更新日志</h2></div>
        <button className="icon-button" aria-label="关闭更新日志" onClick={onClose}><X size={17}/></button>
      </header>
      <div className="app-update-log-content">
        {available && <section className="app-update-release" aria-label={`新版 ${available}`}>
          <h3>新版 v{available}</h3>
          {update.notes?.trim() ? <ReleaseMarkdown text={update.notes}/> : <p>此版本暂无发布说明。</p>}
        </section>}
        {available ? <details className="app-update-past"><summary>本地版本记录</summary><ReleaseMarkdown text={changelog}/></details>
          : <ReleaseMarkdown text={changelog}/>}
      </div>
      <footer className="dialog-footer">
        {update?.version && <span>当前版本 v{update.version}</span>}
        <button className="secondary-button" onClick={onClose}>完成</button>
      </footer>
    </section>
  </dialog>;
}
