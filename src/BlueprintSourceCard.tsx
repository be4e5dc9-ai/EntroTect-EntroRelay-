import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, CircleHelp, Folder, LoaderCircle, MessageSquare, RefreshCw, Search, X } from 'lucide-react';
import { blueprintScopeKey as scopeKey } from '../shared/blueprint';
import { harnessNames } from '../shared/harnesses';
import { projectKey, projectName } from '../shared/project-path';
import type { BlueprintCatalog, BlueprintChat, BlueprintScope, Harness } from '../shared/types';
import { api, message } from './api';
import { HarnessIcon } from './BrandIcon';
import type { Port } from './BlueprintGraph';
import { useI18n } from './i18n';

export type BlueprintFocus = { harness?: Harness; workspace?: string; appId?: string };
const batch = 35;

export function BlueprintSourceCard({ harness, visible, refreshVersion, focus, selected, busy, port, onClose, onSelect, onConfirm }: {
  harness: Harness;
  visible: boolean;
  refreshVersion: number;
  focus?: BlueprintFocus;
  selected?: BlueprintScope;
  busy: boolean;
  port: Port;
  onClose(): void;
  onSelect(scope: BlueprintScope, title: string): void;
  onConfirm(scopes: BlueprintScope[], classification: 'native'|'copy'): Promise<boolean>;
}) {
  const {t}=useI18n();
  const [search,setSearch]=useState('');
  const [expandedRows,setExpandedRows]=useState<Set<string>>(new Set());
  const [limits,setLimits]=useState<Record<string,number>>({});
  const [mode,setMode]=useState<'native'|'pending'>('native');
  const [localRefresh,setLocalRefresh]=useState(0);
  const [result,setResult]=useState<{version:string;catalog?:BlueprintCatalog;error?:string}>();
  const request=useRef<{version:string;promise:Promise<BlueprintCatalog>}|undefined>(undefined);
  const handledFocus=useRef<BlueprintFocus|undefined>(undefined);
  const [scrollKey,setScrollKey]=useState<string>();
  const treeList=useRef<HTMLDivElement>(null);
  const version=`${refreshVersion}:${localRefresh}`;
  const loading=visible && result?.version!==version;
  const catalog=result?.catalog;
  const name=harnessNames[harness];

  useEffect(()=>{
    if(!loading)return;
    if(request.current?.version!==version) {
      request.current={version,promise:api!.blueprintCatalog(harness)};
    }
    let current=true;
    void request.current.promise.then(catalog=>{
      if(current)setResult({version,catalog});
    },error=>{
      if(current)setResult(previous=>({version,catalog:previous?.catalog,error:message(error)}));
    });
    return()=>{current=false;};
  },[harness,loading,version]);

  useEffect(()=>{
    if(!visible||!focus||!catalog||loading||handledFocus.current===focus)return;
    handledFocus.current=focus;
    const review=focus.appId&&catalog.pending.find(chat=>chat.appId===focus.appId);
    if(review){
      setMode('pending');
      setSearch(review.title);
      setLimits({});
      return;
    }
    const chatProject=focus.appId?catalog.projects.find(project=>project.chats.some(chat=>chat.appId===focus.appId)):undefined;
    const chat=chatProject?.chats.find(chat=>chat.appId===focus.appId);
    const matches=catalog.projects.filter(project=>projectKey(project.workspace)===projectKey(focus.workspace||''));
    const project=chatProject??matches.find(project=>projectKey((project.source??catalog.source).location)===projectKey(catalog.source.location))??matches[0];
    if(!project){
      if(focus.appId)setMode('pending');
      return;
    }
    const scope={source:project.source??catalog.source,workspace:project.workspace};
    const key=scopeKey(scope);
    setMode('native');
    setSearch('');
    setExpandedRows(rows=>new Set([...rows,key]));
    setLimits(previous=>({...previous,projects:Math.max(previous.projects??batch,catalog.projects.indexOf(project)+1),
      [key]:Math.max(previous[key]??batch,chat?project.chats.indexOf(chat)+1:0)}));
    onSelect(chat?.scope??scope,chat?.title??projectName(project.workspace));
    if(chat)setScrollKey(scopeKey(chat.scope));
  },[catalog,focus,loading,onSelect,visible]);

  useEffect(()=>{
    if(!scrollKey)return;
    const list=treeList.current;
    const port=Array.from(list?.querySelectorAll<HTMLElement>('[data-scope-port]')??[]).find(element=>element.dataset.scopePort===scrollKey);
    if(list&&port){
      const top=port.offsetTop, bottom=top+port.offsetHeight;
      if(top<list.scrollTop)list.scrollTop=top;
      else if(bottom>list.scrollTop+list.clientHeight)list.scrollTop=bottom-list.clientHeight;
    }
    setScrollKey(undefined);
  },[scrollKey]);

  const query=search.trim().toLowerCase();
  const projects=useMemo(()=>{
    if(!catalog)return [];
    const matchesProject=(project:BlueprintCatalog['projects'][number])=>project.workspace.toLowerCase().includes(query)||(project.source??catalog.source).location.toLowerCase().includes(query);
    return catalog.projects.map(project=>!query||matchesProject(project)?project:{...project,chats:project.chats.filter(chat=>chat.title.toLowerCase().includes(query))})
      .filter(project=>!query||project.chats.length||matchesProject(project));
  },[catalog,query]);
  const pending=useMemo(()=>{
    const groups=new Map<string,BlueprintChat[]>();
    for(const chat of catalog?.pending??[]){
      if(query&&!(chat.title+' '+chat.scope.workspace).toLowerCase().includes(query))continue;
      const key=projectKey(chat.scope.workspace), list=groups.get(key);
      if(list)list.push(chat);
      else groups.set(key,[chat]);
    }
    return [...groups.entries()];
  },[catalog,query]);

  const selectedKey=selected&&scopeKey(selected);
  function toggleRow(key:string){
    setExpandedRows(previous=>{
      const rows=new Set(previous);
      if(rows.has(key))rows.delete(key);
      else rows.add(key);
      return rows;
    });
  }
  function more(key:string,count:number){
    const limit=limits[key]??batch;
    return count>limit&&<button className="bp-more" onClick={()=>setLimits(previous=>({...previous,[key]:limit+batch}))}>
      {t("再显示 {0} 项",Math.min(batch,count-limit))}
    </button>;
  }
  async function confirm(scopes:BlueprintScope[],classification:'native'|'copy'){
    if(await onConfirm(scopes,classification))setLocalRefresh(previous=>previous+1);
  }
  return <section className="bp-tree" aria-label={t("{0} 的来源目录",name)}>
    <header><HarnessIcon h={harness}/><h3>{name}</h3>
      <button className="icon-button bp-card-refresh" title={t("刷新来源")} disabled={loading||busy}
        onClick={()=>setLocalRefresh(previous=>previous+1)}><RefreshCw size={15} className={loading?'spin':''}/></button>
      <button className="icon-button" title={t("收起 {0} 来源",name)} onClick={onClose}><X size={15}/></button>
    </header>
    {catalog&&<div className="bp-location" title={catalog.source.location}>{catalog.source.location}</div>}
    <label className="bp-search"><Search size={14}/><input aria-label={t("搜索来源项目或对话")} placeholder={t("搜索项目或对话")}
      value={search} onChange={event=>{setSearch(event.target.value);setLimits({});}}/></label>
    <div className="bp-tabs">
      <button aria-pressed={mode==='native'} onClick={()=>setMode('native')}><Folder size={13}/>{t("原生项目")}</button>
      <button aria-pressed={mode==='pending'} onClick={()=>setMode('pending')}><CircleHelp size={13}/>{t("来源待确认")} <span>{catalog?.pending.length??0}</span></button>
    </div>
    {mode==='pending'&&!!catalog?.pending.length&&<div className="bp-review-summary">
      <p>{t("这些旧对话没有足够的来源记录。确认后才能加入整组同步。")}</p>
      <button className="secondary-button" disabled={busy||loading} onClick={()=>void confirm(catalog.pending.map(chat=>chat.scope),'native')}>
        {t("将全部 {0} 条确认为原生",catalog.pending.length)}
      </button>
    </div>}
    <div className="bp-tree-list" ref={treeList}>
      {loading&&!catalog&&<div className="bp-list-empty" role="status"><LoaderCircle size={18} className="spin"/>{t("正在读取本地历史…")}</div>}
      {mode==='native'&&projects.slice(0,limits.projects??batch).map(project=>{
        const source=project.source??catalog!.source, scope={source,workspace:project.workspace};
        const key=scopeKey(scope), expanded=expandedRows.has(key)||!!query;
        const showLocation=projectKey(source.location)!==projectKey(catalog!.source.location)||
          catalog!.projects.some(other=>projectKey(other.workspace)===projectKey(project.workspace)&&projectKey((other.source??catalog!.source).location)!==projectKey(source.location));
        const name=project.workspace?projectName(project.workspace):t("未指定目录");
        return <div key={key} className="bp-project">
          <div className="bp-row" data-chosen={selectedKey===key}>
            <button className="bp-item" aria-expanded={expanded} title={project.workspace} onClick={()=>{toggleRow(key);onSelect(scope,name);}}>
              {expanded?<ChevronDown size={13}/>:<ChevronRight size={13}/>}<Folder size={15}/><span>{name}</span><small>{project.chats.length}</small>
            </button>
            {project.workspace&&port(scope,name)}
          </div>
          {showLocation&&<div className="bp-location bp-project-location" title={source.location}>{source.location}</div>}
          {expanded&&<>{project.chats.slice(0,limits[key]??batch).map(chat=>{
            const chatKey=scopeKey(chat.scope);
            return <div className="bp-row bp-chat" key={chatKey} data-chosen={selectedKey===chatKey}>
              <button className="bp-item" title={chat.title} onClick={()=>onSelect(chat.scope,chat.title)}><MessageSquare size={13}/><span>{chat.title}</span></button>
              {port(chat.scope,chat.title)}
            </div>;
          })}{more(key,project.chats.length)}</>}
        </div>;
      })}
      {mode==='native'&&more('projects',projects.length)}
      {mode==='pending'&&pending.slice(0,limits.pending??batch).map(([key,chats])=>{
        const name=chats[0].scope.workspace?projectName(chats[0].scope.workspace):t("未指定目录");
        const rowKey='pending:'+key, expanded=expandedRows.has(rowKey)||!!query;
        return <div key={key} className="bp-review-group">
          <button aria-expanded={expanded} onClick={()=>toggleRow(rowKey)}>
            {expanded?<ChevronDown size={13}/>:<ChevronRight size={13}/>}<Folder size={14}/><strong>{name}</strong><small>{chats.length}</small>
          </button>
          <div className="bp-classify">
            <button disabled={busy} onClick={()=>void confirm(chats.map(chat=>chat.scope),'native')}>{t("确认为原生")} ({chats.length})</button>
            <button disabled={busy} onClick={()=>void confirm(chats.map(chat=>chat.scope),'copy')}>{t("标为副本")} ({chats.length})</button>
          </div>
          {expanded&&<>{chats.slice(0,limits[rowKey]??batch).map(chat=><div key={scopeKey(chat.scope)} className="bp-review-chat">
            <span title={chat.title}>{chat.title}</span>
            <div className="bp-classify"><button disabled={busy} onClick={()=>void confirm([chat.scope],'native')}>{t("确认为原生")}</button>
              <button disabled={busy} onClick={()=>void confirm([chat.scope],'copy')}>{t("标为副本")}</button></div>
          </div>)}{more(rowKey,chats.length)}</>}
        </div>;
      })}
      {mode==='pending'&&more('pending',pending.length)}
      {!loading&&!(result?.error&&!catalog)&&(mode==='native'?!projects.length:!pending.length)&&<div className="bp-list-empty">
        {query?t("没有匹配的项目或对话"):mode==='native'?t("这里还没有已确认的原生项目"):t("没有待确认的记录")}
      </div>}
    </div>
    {!loading&&result?.error&&<div className="bp-warnings bp-error" role="alert">{t(result.error)}</div>}
    {!!catalog?.warnings.length&&<details className="bp-warnings"><summary>{t("{0} 条读取提示",catalog.warnings.length)}</summary>
      {catalog.warnings.map((warning,index)=><p key={index}>{t(warning)}</p>)}
    </details>}
  </section>;
}
