import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import type { DesktopApi } from '../shared/types';
import { slashPrefix, type HarnessCommand } from '../shared/commands';
import { projectKey } from '../shared/project-path';
import { api, message } from './api';
import { HarnessIcon } from './BrandIcon';
import { harnessNames } from '../shared/harnesses';
import './command-input.css';

type Scope = Parameters<DesktopApi['listCommands']>[0];
type Catalog = { commands?: HarnessCommand[]; loadedAt?: number; loading?: boolean; error?: string };
const catalogLifetime = 5 * 60_000;
const catalogLimit = 24;

export function CommandInput({ value, onChange, onSend, scope, cacheScope, disabled }: {
  value: string;
  onChange(value: string): void;
  onSend(): void;
  scope: Scope;
  cacheScope: string;
  disabled: boolean;
}) {
  const { harness, workspace, modelId, id } = scope;
  const prefix = slashPrefix(value);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [catalogs, setCatalogs] = useState(() => new Map<string, Catalog>());
  const inFlight = useRef(new Set<string>());
  const input = useRef<HTMLTextAreaElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const key = JSON.stringify([harness, projectKey(workspace), modelId, cacheScope]);
  const open = !!api?.listCommands && focused && !dismissed && !disabled && prefix !== undefined;
  const catalog = catalogs.get(key);
  const loaded = catalog?.commands !== undefined || !!catalog?.error;
  const matches = catalog?.commands?.filter(command => command.name.toLowerCase().startsWith(prefix?.toLowerCase() ?? '')) ?? [];
  const current = matches[active] ?? matches[0];
  const readCatalog = useCallback(() => {
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    const update = (fields: Partial<Catalog>) => setCatalogs(previous => {
      const next = new Map(previous);
      const entry = { ...next.get(key), ...fields };
      next.delete(key);
      next.set(key, entry);
      if (next.size > catalogLimit) next.delete(next.keys().next().value!);
      return next;
    });
    update({ loading: true, error: undefined });
    void api!.listCommands({ harness, workspace, modelId, id }).then(
      commands => update({ commands, loadedAt: Date.now(), loading: false }),
      error => update({ error: message(error), loading: false }),
    ).finally(() => inFlight.current.delete(key));
  }, [key, harness, workspace, modelId, id]);
  useEffect(() => {
    if (!open) return;
    setActive(0);
    if (catalog?.loadedAt !== undefined && Date.now() - catalog.loadedAt < catalogLifetime) return;
    const timer = setTimeout(readCatalog, 120);
    return () => clearTimeout(timer);
  }, [open, readCatalog, catalog?.loadedAt]);
  useEffect(() => {
    if (open && current) document.getElementById(`slash-option-${current.name}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, current]);
  function choose(command: HarnessCommand) {
    onChange(`/${command.name}${command.inputHint ? ' ' : ''}`);
    setDismissed(true);
    input.current?.focus();
  }
  return <>
    {open && <div ref={menu} className="slash-menu" onBlur={event => {
      if (event.relatedTarget !== input.current && !event.currentTarget.contains(event.relatedTarget)) setFocused(false);
    }}>
      <header><HarnessIcon h={harness}/><strong>{harnessNames[harness]}</strong><span>斜杠命令</span>
        <button type="button" className="icon-button" aria-label="刷新斜杠命令" title="刷新斜杠命令" disabled={catalog?.loading}
          onMouseDown={event => event.preventDefault()} onClick={() => { input.current?.focus(); readCatalog(); }}>
          <RefreshCw size={14} className={catalog?.loading ? 'spin' : undefined}/>
        </button>
      </header>
      {catalog?.commands && catalog.error && <p role="status">{catalog.error}</p>}
      {!loaded ? <p role="status"><LoaderCircle className="spin" size={14}/>正在读取命令…</p>
        : !catalog?.commands ? <p role="status">{catalog?.error}</p>
        : matches.length ? <div id="slash-options" role="listbox" aria-label="斜杠命令">
          {matches.map((command, index) => <div id={`slash-option-${command.name}`} role="option" aria-selected={command === current}
            key={command.name} onMouseMove={() => setActive(index)} onMouseDown={e => e.preventDefault()} onClick={() => choose(command)}>
            <span><strong>/{command.name}</strong>{command.inputHint && <code>{command.inputHint}</code>}</span>
            {command.description && <small>{command.description}</small>}
          </div>)}
        </div> : <p role="status">没有匹配的命令</p>}
    </div>}
    <textarea ref={input} aria-label="任务输入" rows={1} placeholder="和 EntroTect 一起工作"
      title="Enter 发送 · Shift + Enter 换行 · 输入 / 查看命令"
      aria-controls={open && matches.length ? 'slash-options' : undefined}
      aria-activedescendant={open && current ? `slash-option-${current.name}` : undefined}
      value={value} onFocus={() => { setFocused(true); setDismissed(false); }} onBlur={event => {
        if (!menu.current?.contains(event.relatedTarget)) setFocused(false);
      }}
      onChange={e => { onChange(e.target.value); setActive(0); setDismissed(false); }}
      onKeyDown={e => {
        if (e.nativeEvent.isComposing) return;
        if (open && e.key === 'Escape') { e.preventDefault(); setDismissed(true); return; }
        if (open && matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          const index = matches.indexOf(current);
          setActive((index + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
          return;
        }
        if (open && current && (e.key === 'Tab' && !e.shiftKey || e.key === 'Enter' && !e.shiftKey && prefix !== current.name)) {
          e.preventDefault();
          choose(current);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (value.trim() !== '/' && !(open && !loaded)) onSend();
        }
      }}/>
  </>;
}
