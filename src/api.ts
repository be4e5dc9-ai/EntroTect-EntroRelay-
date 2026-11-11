import type { DesktopApi } from '../shared/types';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
declare global { interface Window { entrotect?: DesktopApi } }
const call=<T,>(method:string,params:Record<string,unknown>={})=>invoke<T>('desktop_call',{method,params});
const tauriApi:DesktopApi={
  appUpdateStatus:()=>call('app:updateStatus'),checkAppUpdate:()=>call('app:checkUpdate'),installAppUpdate:()=>call('app:installUpdate'),
  launchAgentLogin:harness=>call('agent:login',{harness}),
  nativeModels:scope=>call('models:native',scope),
  listCommands:scope=>call('commands:list',scope),
  syncHistory:()=>call('history:sync'),historySyncStatus:()=>call('history:status'),
  harnessUpdateStatus:()=>call('runtime:updateStatus'),checkHarnessUpdates:()=>call('runtime:checkUpdates'),
  selectReasoning:(id,level)=>call('conversation:reasoning',{id,level}),relocateConversation:(id,workspace)=>call('conversation:workspace',{id,workspace}),
  historyDefaults:()=>call('history:defaults'),listHistory:source=>call('history:list',{source}),
  historyExportSelection:scope=>call('history:export-selection',{scope}),setHistoryExportSelection:(scope,rules)=>call('history:save-export-selection',{scope,rules}),
  setHistoryImportRule:rule=>call('history:import-selection',{rule}),
  importHistory:request=>call('history:import',{request}),exportHistory:request=>call('history:export',{request}),chooseDatabase:()=>call('dialog:database'),
  bootstrap:()=>call('bootstrap'),rememberRuntime:selection=>call('runtime:selection',{...selection}),
  addProject:workspace=>call('project:add',{workspace}),
  createProject:(parent,name)=>call('project:create',{parent,name}),accountUsage:(harness,refresh)=>call('account:usage',{harness,refresh}),
  tokenActivity:()=>call('account:activity'),
  createConversation:(workspace,harness)=>call('conversation:create',{workspace,harness}),
  loadConversation:id=>call('conversation:load',{id}),send:(id,text)=>call('conversation:send',{id,text}),
  stop:id=>call('conversation:stop',{id}),switchHarness:(id,harness)=>call('conversation:switch',{id,harness}),
  selectModel:(id,modelId,harness)=>call('conversation:selection',{id,modelId,harness}),
  saveSettings:(settings,keys)=>call('settings:save',{settings,keys}),chooseDirectory:()=>call('dialog:directory'),chooseExecutable:()=>call('dialog:executable'),
  context:id=>call('conversation:context',{id}),answerApproval:(id,allow,answer)=>call('approval:answer',{id,allow,answer}),
  openPath:path=>call('path:open',{path}),openLink:url=>call('link:open',{url}),exportContext:id=>call('context:export',{id}),
  listFiles:(workspace,path='')=>call('workspace:files',{workspace,path}),readFile:(workspace,path)=>call('workspace:read',{workspace,path}),
  readFileReference:(workspace,reference)=>call('workspace:read-reference',{workspace,reference}),
  gitStatus:workspace=>call('workspace:git',{workspace}),gitDiff:(workspace,path)=>call('workspace:diff',{workspace,path}),
  onEvent:callback=>{let cancelled=false;let off:(()=>void)|undefined;void listen<import('../shared/types').DesktopEvent>('entrotect:event',event=>callback(event.payload)).then(unlisten=>{if(cancelled)unlisten();else off=unlisten;});return()=>{cancelled=true;off?.();};},
};
export const api = isTauri() ? tauriApi : window.entrotect;
if(api)window.entrotect=api;
export const closeWindow=()=>call('window:close');
export type BrowserBounds = { x: number; y: number; width: number; height: number };
export type BrowserStatus = { id: string; url: string; loading: boolean; back: boolean; forward: boolean; error?: string };
type BrowserCommand = { action: 'navigate'; url: string } | { action: 'bounds'; bounds: BrowserBounds }
  | { action: 'hide' | 'close' | 'back' | 'forward' | 'reload' };
let browserCommands = Promise.resolve();
export const previewBrowser = isTauri() ? {
  send: (id: string, command: BrowserCommand) => {
    const result = browserCommands.then(() => call<void>('browser:preview', { id, ...command }));
    browserCommands = result.catch(() => {});
    return result;
  },
  onStatus: (callback: (status: BrowserStatus) => void) => listen<BrowserStatus>('entrotect:browser', event => callback(event.payload)),
} : undefined;
export function message(error: unknown) { return String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
