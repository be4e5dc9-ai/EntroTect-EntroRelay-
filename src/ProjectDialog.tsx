import { useEffect, useState } from 'react';
import { FolderOpen, FolderPlus, LoaderCircle, X } from 'lucide-react';
import { api, message } from './api';

export function ProjectDialog({ onClose, onProject }: { onClose(): void; onProject(directory: string): void }) {
  const [mode, setMode] = useState<'open' | 'create'>('open');
  const [paths, setPaths] = useState({ open: '', create: '' });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const directory = paths[mode];
  useEffect(() => {
    function close(event: KeyboardEvent) { if (event.key === 'Escape' && !busy) onClose(); }
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [busy, onClose]);
  async function choose() {
    if (!api || busy) return;
    setBusy(true);
    setError('');
    try {
      const selected = await api.chooseDirectory();
      if (selected) setPaths(old => ({ ...old, [mode]: selected }));
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (!api || busy || !directory || (mode === 'create' && !name.trim())) return;
    setBusy(true);
    setError('');
    try {
      const project = mode === 'open' ? await api.addProject(directory) : await api.createProject(directory, name);
      onProject(project);
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onClick={() => { if (!busy) onClose(); }}>
    <section className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" onClick={event => event.stopPropagation()}>
      <header className="dialog-header">
        <div><FolderPlus size={18}/><h2 id="project-dialog-title">添加项目</h2></div>
        <button className="icon-button" title="关闭项目窗口" disabled={busy} onClick={onClose}><X size={17}/></button>
      </header>
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <div className="project-dialog-body">
          <div className="segmented" aria-label="项目类型">
            <button type="button" aria-pressed={mode === 'open'} disabled={busy} onClick={() => { setMode('open'); setError(''); }}><FolderOpen size={15}/>打开目录</button>
            <button type="button" aria-pressed={mode === 'create'} disabled={busy} onClick={() => { setMode('create'); setError(''); }}><FolderPlus size={15}/>新建目录</button>
          </div>
          {mode === 'create' && <label className="form-field">项目名称<input autoFocus value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder="例如 my-project"/></label>}
          <label className="form-field">{mode === 'open' ? '项目目录' : '父目录'}
            <div className="path-input">
              <input readOnly value={directory} title={directory} placeholder="从本机选择目录"/>
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void choose()}><FolderOpen size={15}/>选择目录</button>
            </div>
          </label>
          <p>{mode === 'open' ? '在此目录中使用 Agent，相关对话会归入这个项目。' : '将在父目录中创建文件夹，并将它添加到项目列表。'}</p>
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
        <footer className="dialog-footer">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
          <button className="primary-button" disabled={busy || !directory || (mode === 'create' && !name.trim())}>
            {busy && <LoaderCircle size={14} className="spin"/>}{mode === 'open' ? '打开项目' : '创建项目'}
          </button>
        </footer>
      </form>
    </section>
  </div>;
}
