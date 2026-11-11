import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RefreshCw } from 'lucide-react';
import { webAddress } from '../shared/preview-link';
import { api, message, previewBrowser, type BrowserStatus } from './api';

export function WebPreview({ active, hidden, request }: {
  active: boolean; hidden: boolean; request?: { url: string };
}) {
  const id = useId();
  const surface = useRef<HTMLDivElement>(null);
  const editingAddress = useRef(false);
  const ready = useRef<Promise<unknown>>(Promise.resolve());
  const navigation = useRef(0);
  const [created, setCreated] = useState(false);
  const [address, setAddress] = useState('');
  const [status, setStatus] = useState<BrowserStatus>();
  const [error, setError] = useState('');

  useEffect(() => {
    const browser = previewBrowser;
    if (!browser) return;
    let subscribed = true;
    let unlisten: (() => void) | undefined;
    ready.current = browser.onStatus(next => {
      if (!subscribed || next.id !== id) return;
      setStatus(old => next.url ? next : { ...next, url: old?.url || '' });
      if (next.url && !editingAddress.current) setAddress(next.url);
    }).then(off => {
      if (subscribed) unlisten = off;
      else off();
    }).catch(error => { if (subscribed) setError(message(error)); });
    return () => {
      navigation.current++;
      subscribed = false;
      unlisten?.();
      void browser.send(id, { action: 'close' }).catch(() => {});
    };
  }, [id]);

  const navigate = useCallback(async (input: string) => {
    const url = webAddress(input, true);
    if (!url) { setError('请输入有效的 HTTP 或 HTTPS 网址'); return; }
    if (!previewBrowser) { setError('网页预览需要在桌面版中使用'); return; }
    const ticket = ++navigation.current;
    setError('');
    editingAddress.current = false;
    setAddress(url);
    await ready.current;
    if (ticket !== navigation.current) return;
    try {
      await previewBrowser.send(id, { action: 'navigate', url });
      if (ticket === navigation.current) setCreated(true);
    } catch (error) {
      if (ticket === navigation.current) setError(message(error));
    }
  }, [id]);

  useEffect(() => { if (request) void navigate(request.url); }, [request, navigate]);

  useLayoutEffect(() => {
    const browser = previewBrowser;
    const slot = surface.current;
    const pane = slot?.closest<HTMLElement>('.project-pane');
    const layout = pane?.closest<HTMLElement>('.workspace-layout');
    if (!active || !created || !browser || !slot || !pane || !layout) return;
    let frame = 0;
    let visibleBounds = '';
    const hide = () => {
      if (!visibleBounds) return;
      visibleBounds = '';
      void browser.send(id, { action: 'hide' }).catch(() => {});
    };
    function place() {
      frame = 0;
      const rect = slot!.getBoundingClientRect();
      const clip = pane!.getBoundingClientRect();
      if (document.hidden || layout!.dataset.resizing === 'right'
        || rect.width < 10 || rect.height < 10 || rect.left < clip.left - 0.5 || rect.right > clip.right + 0.5) {
        hide();
        return;
      }
      const scale = window.devicePixelRatio;
      const x = Math.round(rect.left * scale);
      const y = Math.round(rect.top * scale);
      const width = Math.round(rect.right * scale) - x;
      const height = Math.round(rect.bottom * scale) - y;
      const key = `${x}:${y}:${width}:${height}`;
      if (key === visibleBounds) return;
      visibleBounds = key;
      void browser!.send(id, { action: 'bounds', bounds: { x, y, width, height } }).catch(error => setError(message(error)));
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
    const resize = new ResizeObserver(schedule);
    resize.observe(slot);
    resize.observe(pane);
    const drag = new MutationObserver(() => {
      if (layout.dataset.resizing === 'right') hide();
      else schedule();
    });
    drag.observe(layout, { attributes: true, attributeFilter: ['data-resizing'] });
    window.addEventListener('resize', schedule);
    document.addEventListener('visibilitychange', schedule);
    place();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      drag.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', schedule);
      hide();
    };
  }, [active, created, id]);

  function run(action: 'back' | 'forward' | 'reload') {
    setError('');
    editingAddress.current = false;
    void previewBrowser?.send(id, { action }).catch(error => setError(message(error)));
  }
  const problem = error || status?.error;
  return <div className="web-preview" hidden={hidden} role="tabpanel" aria-label="网页预览">
    <div className="web-preview-toolbar" role="toolbar" aria-label="网页导航">
      <button className="icon-button" title="后退" aria-label="后退" disabled={!status?.back} onClick={() => run('back')}><ArrowLeft size={15}/></button>
      <button className="icon-button" title="前进" aria-label="前进" disabled={!status?.forward} onClick={() => run('forward')}><ArrowRight size={15}/></button>
      <button className="icon-button" title="重新加载网页" aria-label="重新加载网页" disabled={!created} onClick={() => run('reload')}>
        <RefreshCw size={14} className={status?.loading ? 'spin' : undefined}/>
      </button>
      <form onSubmit={event => { event.preventDefault(); void navigate(address); }}>
        <input aria-label="网址" type="text" inputMode="url" autoComplete="off" spellCheck={false} placeholder="输入网址"
          value={address} onChange={event => { editingAddress.current = true; setAddress(event.target.value); }}
          onKeyDown={event => {
            if (event.key !== 'Escape') return;
            editingAddress.current = false;
            setAddress(status?.url || '');
          }}/>
      </form>
      <button className="icon-button" title="在浏览器中打开" aria-label="在浏览器中打开" disabled={!status?.url}
        onClick={() => { if (status?.url) void api?.openLink(status.url).catch(error => setError(message(error))); }}>
        <ExternalLink size={14}/>
      </button>
    </div>
    {problem && <div className="project-error" role="alert">{problem}</div>}
    <div ref={surface} className="web-preview-surface" aria-busy={status?.loading || undefined}>
      {!created && <div className="project-empty"><Globe size={24}/><p>打开网页</p><span>输入网址，或点击对话里的链接</span></div>}
    </div>
  </div>;
}
