import { useI18n } from './i18n';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, File, FileCode2, FileDiff, Folder, FolderOpen, GitBranch, Globe, Link, LoaderCircle, RefreshCw } from 'lucide-react';
import type { DirectoryListing, GitChange, GitStatus } from '../shared/types';
import type { FileReference, PreviewLink } from '../shared/preview-link';
import { projectName } from '../shared/project-path';
import { api, message } from './api';
import { FileViewer, type Preview } from './FileViewer';
import { WebPreview } from './WebPreview';

const noChanges: GitChange[] = [];
export function ProjectSidebar({ workspace, revision, active, onChoose, canChoose, link }: {
  workspace: string; revision?: number; active: boolean; onChoose(): void; canChoose: boolean; link?: PreviewLink;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'files' | 'changes' | 'web'>('files');
  const [webRequest, setWebRequest] = useState<Extract<PreviewLink, { kind: 'web' }>>();
  const [webOpened, setWebOpened] = useState(false);
  const [version, setVersion] = useState(0);
  const [git, setGit] = useState<GitStatus>();
  const [gitError, setGitError] = useState('');
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const request = useRef(0);
  const pane = useRef<HTMLElement>(null);
  const restorePreviewFocus = useRef(false);
  const changes = git?.changes ?? noChanges;
  const changesByPath = useMemo(() => new Map(changes.map(change => [change.path, change])), [changes]);

  useEffect(() => {
    if (!active || !workspace || !api || tab === 'web') return;
    let disposed = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refreshGit() {
      if (disposed || pending || document.hidden) return;
      pending = true;
      setLoading(true);
      try {
        const next = await api!.gitStatus(workspace);
        if (disposed) return;
        setGit(next);
        setGitError('');
        if (tab === 'changes' && next.repository && !document.hidden) timer = setTimeout(refreshGit, 5000);
      } catch (error) {
        if (!disposed) setGitError(message(error));
      } finally {
        pending = false;
        if (!disposed) setLoading(false);
      }
    }
    function visibilityChanged() {
      clearTimeout(timer);
      void refreshGit();
    }
    void refreshGit();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [active, workspace, revision, version, tab]);
  useLayoutEffect(() => {
    if (!expanded && restorePreviewFocus.current) {
      pane.current?.querySelector<HTMLButtonElement>('[data-expand-preview]')?.focus();
      restorePreviewFocus.current = false;
    }
  }, [expanded]);

  const openPreview = useCallback(async (path: string, kind: Preview['kind'], reference?: FileReference) => {
    const ticket = ++request.current;
    setOpening(true);
    setError('');
    try {
      if (!api) throw new Error(t("文件预览需要在桌面版中使用"));
      const next: Preview = kind === 'diff'
        ? { kind, data: await api.gitDiff(workspace, path) }
        : { kind, data: reference ? await api.readFileReference(workspace, reference) : await api.readFile(workspace, path), reference };
      if (ticket === request.current) setPreview(next);
    } catch (error) {
      if (ticket === request.current) setError(message(error));
    } finally {
      if (ticket === request.current) setOpening(false);
    }
  }, [workspace]);
  const openFile = useCallback((path: string) => { void openPreview(path, 'file'); }, [openPreview]);
  const closePreview = useCallback(() => {
    request.current++;
    setPreview(undefined);
    setExpanded(false);
    setOpening(false);
    setError('');
  }, []);
  useEffect(() => {
    if (link?.kind === 'web') {
      setWebOpened(true);
      setWebRequest(link);
      setTab('web');
    } else if (link?.kind === 'file') {
      closePreview();
      setTab('files');
      void openPreview(link.reference.path, 'file', link.reference);
    }
  }, [link, openPreview, closePreview]);
  function showTab(next: typeof tab) {
    if (next === tab) return;
    if (next === 'web') setWebOpened(true);
    else if (tab !== 'web' || preview?.kind !== (next === 'files' ? 'file' : 'diff')) closePreview();
    setTab(next);
  }
  function closeExpanded() {
    restorePreviewFocus.current = true;
    setExpanded(false);
  }
  function reload() {
    setVersion(old => old + 1);
    if (preview) void openPreview(preview.data.path, preview.kind, preview.kind === 'file' ? preview.reference : undefined);
  }
  return <aside ref={pane} className="project-sidebar" aria-label={t("项目侧栏")} onKeyDown={event => {
    if (event.key === 'Escape' && tab !== 'web' && preview && !expanded && !event.defaultPrevented) {
      event.preventDefault();
      closePreview();
    }
  }}>
    <header className="project-sidebar-header">
      <strong>{t("项目")}</strong>
      <div>
        {canChoose && <button className="icon-button" title={t("选择项目目录")} onClick={onChoose}><FolderOpen size={16}/></button>}
        <button className="icon-button" title={t("在资源管理器中打开项目")} disabled={!workspace}
          onClick={() => void api?.openPath(workspace).catch(error => setError(message(error)))}><Folder size={16}/></button>
        <button className="icon-button" title={t("刷新项目")} disabled={!workspace} onClick={reload}>
          <RefreshCw size={15} className={loading ? 'spin' : undefined}/>
        </button>
      </div>
    </header>
    <div className="project-tabs" role="tablist" aria-label={t("项目视图")}>
      <button role="tab" aria-selected={tab === 'files'} onClick={() => showTab('files')}><FileCode2 size={14}/>{t("文件")}</button>
      <button role="tab" aria-selected={tab === 'changes'} onClick={() => showTab('changes')}><FileDiff size={14}/>{t("改动")}{" "}{changes.length > 0 && <span>{changes.length}</span>}
      </button>
      <button role="tab" aria-selected={tab === 'web'} onClick={() => showTab('web')}><Globe size={14}/>{t("网页")}</button>
    </div>
    {tab === 'files' && workspace && <div className="project-folder" title={workspace}><FolderOpen size={13}/><span>{projectName(workspace)}</span></div>}
    <div hidden={tab !== 'files'} className="project-content" role="tabpanel" aria-label={t("项目文件")}>
      {workspace && api
        ? <FileTree workspace={workspace} path="" depth={0} version={`${revision ?? ''}:${version}`} active={active && tab === 'files'}
          onOpen={openFile} selectedPath={preview?.kind === 'file' ? preview.data.path : undefined} changes={changesByPath}/>
        : <div className="project-empty"><FolderOpen size={26}/><p>{t("选择项目目录")}</p><span>{t("在这里浏览文件与代码")}</span></div>}
    </div>
    {tab === 'changes' && <div className="project-content" role="tabpanel" aria-label={t("Git 改动")}>
      {gitError ? <div className="project-error" role="alert">{t(gitError)}</div>
        : !git && loading ? <div className="project-empty"><LoaderCircle size={21} className="spin"/><p>{t("正在读取改动")}</p></div>
        : !git?.available ? <div className="project-empty"><GitBranch size={25}/><p>{t("未检测到 Git")}</p><span>{t("安装 Git 后可查看项目改动")}</span></div>
        : !git.repository ? <div className="project-empty"><GitBranch size={25}/><p>{t("当前目录不是 Git 仓库")}</p></div>
        : !changes.length ? <div className="project-empty"><FileDiff size={26}/><p>{t("工作区没有改动")}</p></div>
        : <div className="change-list">
          <div className="change-list-label">{t("{0} 个文件发生变化", changes.length)}</div>
          {changes.map(change => <button className="change-row" key={change.path}
            title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
            aria-current={preview?.kind === 'diff' && preview.data.path === change.path || undefined}
            onClick={() => void openPreview(change.path, 'diff')}>
            <File size={15}/><span><strong>{change.path.split('/').at(-1)}</strong>
              <small>{change.oldPath ? `${change.oldPath} → ${change.path}` : change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : t("项目根目录")}</small>
            </span><ChangeBadge change={change}/>
          </button>)}
        </div>}
    </div>}
    {webOpened && <WebPreview active={active && tab === 'web'} hidden={tab !== 'web'} request={webRequest}/>}
    {tab !== 'web' && opening && <div className="project-opening" role="status"><LoaderCircle size={13} className="spin"/>{t("正在打开文件…")}</div>}
    {tab !== 'web' && error && <div className="project-error" role="alert">{t(error)}</div>}
    {tab !== 'web' && preview && <div className="project-preview">
      <FileViewer preview={preview} inline={!expanded} onClose={expanded ? closeExpanded : closePreview}
        onExpand={() => setExpanded(true)}/>
    </div>}
    {tab !== 'web' && <footer className="project-sidebar-footer">
      <GitBranch size={13}/><span>{git?.repository ? git.branch : git?.available ? t("无 Git 仓库") : t("Git 未连接")}</span>
      {git?.repository && <small>{changes.length ? t("{0} 个改动", changes.length) : t("工作区干净")}</small>}
    </footer>}
  </aside>;
}

const changeNames: Record<string, string> = { '?': '未跟踪', A: '新增', M: '修改', D: '删除', R: '重命名', U: '冲突', C: '复制' };
function ChangeBadge({ change }: { change: GitChange }) {
  const { t } = useI18n();
  const code = change.index === '?' || change.index === 'R' ? change.index : change.worktree.trim() || change.index.trim();
  return <span className={`change-badge status-${code === '?' ? 'new' : code}`}
    title={t("{0} · 暂存区 {1} / 工作区 {2}", t(changeNames[code]) || code, change.index.trim() || t("无"), change.worktree.trim() || t("无"))}>{code}</span>;
}

const FileTree = memo(function FileTreeView({ workspace, path, depth, version, active, onOpen, changes, selectedPath }: {
  workspace: string; path: string; depth: number; version: string; active: boolean;
  onOpen(path: string): void; changes: ReadonlyMap<string, GitChange>; selectedPath?: string;
}) {
  const { t } = useI18n();
  const [listing, setListing] = useState<DirectoryListing>();
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const loadedVersion = useRef('');
  useEffect(() => {
    if (!active || loadedVersion.current === version) return;
    let valid = true;
    setError('');
    void api!.listFiles(workspace, path).then(value => {
      if (!valid) return;
      loadedVersion.current = version;
      setListing(value);
    }, error => { if (valid) setError(message(error)); });
    return () => { valid = false; };
  }, [workspace, path, version, active]);
  if (error) return <div className="tree-error">{t(error)}</div>;
  if (!listing) return <div className="tree-loading"><LoaderCircle size={12} className="spin"/>{t("读取目录…")}</div>;
  return <div className="file-tree">
    {listing.entries.map(entry => {
      const open = expanded.has(entry.path);
      const change = changes.get(entry.path);
      return <div key={entry.path}>
        <button className={`file-row ${entry.kind === 'link' ? 'is-link' : ''}`} style={{ paddingLeft: 12 + depth * 14 }}
          title={entry.kind === 'link' ? t("{0}（链接）", entry.name) : entry.path} disabled={entry.kind === 'link'}
          aria-current={entry.path === selectedPath || undefined} aria-expanded={entry.kind === 'directory' ? open : undefined}
          onClick={() => {
            if (entry.kind !== 'directory') { onOpen(entry.path); return; }
            setExpanded(old => {
              const next = new Set(old);
              if (next.has(entry.path)) next.delete(entry.path);
              else next.add(entry.path);
              return next;
            });
          }}>
          {entry.kind === 'directory' ? <ChevronRight size={12}/> : <span className="tree-spacer"/>}
          {entry.kind === 'directory' ? open ? <FolderOpen size={15}/> : <Folder size={15}/>
            : entry.kind === 'link' ? <Link size={14}/> : <FileCode2 size={14}/>}
          <span>{entry.name}</span>{change && <ChangeBadge change={change}/>}
        </button>
        {open && entry.kind === 'directory' && <FileTree workspace={workspace} path={entry.path} depth={depth + 1}
          version={version} active={active} onOpen={onOpen} changes={changes} selectedPath={selectedPath}/>}
      </div>;
    })}
    {!listing.entries.length && <div className="tree-empty" style={{ paddingLeft: 24 + depth * 14 }}>{t("空目录")}</div>}
    {listing.truncated && <div className="tree-error">{t("此目录仅显示前 500 项")}</div>}
  </div>;
});
