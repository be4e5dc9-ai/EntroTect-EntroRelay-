import {spawn} from 'node:child_process';
import type {Harness} from '../shared/types';
export type NativeActivity = Partial<Record<Harness, boolean>> & { codexWriters?: (string | null)[] };
// A desktop harness can retain a decoded session after its last turn. Updating
// its file behind that cache would let a later append reuse old sequence IDs.
// Inspect process identity only; prompts/credentials are never returned.
export async function nativeActivity():Promise<NativeActivity>{
 if(process.platform!=='win32')return {};
 const script=String.raw`
$all = @(Get-CimInstance Win32_Process)
$owned = [System.Collections.Generic.HashSet[int]]::new()
[void]$owned.Add([int]$env:ENTROTECT_WORKER_PID)
do {
  $changed = $false
  foreach ($p in $all) {
    if ($owned.Contains([int]$p.ParentProcessId) -and $owned.Add([int]$p.ProcessId)) { $changed = $true }
  }
} while ($changed)
$clients = @{deepseek=$false;zcode=$false;kimi=$false;opencode=$false;codex=$false;codexWriters=@()}
foreach ($p in $all) {
  if ($owned.Contains([int]$p.ProcessId)) { continue }
  if ($p.Name -match '^DeepSeek Harness(?:\.exe)?$' -or $p.CommandLine -match '[\\/]@deepseek-ai[\\/](dsh|dsh-desktop-host)[\\/]') { $clients.deepseek = $true }
  if ($p.Name -match '^ZCode(?:\.exe)?$' -or $p.CommandLine -match '[\\/]zcode\.cjs') { $clients.zcode = $true }
  if ($p.Name -match '^Kimi(?: Code)?(?:\.exe)?$' -or $p.CommandLine -match '[\\/]@moonshot-ai[\\/]kimi-code[\\/]') { $clients.kimi = $true }
  if ($p.Name -match '^(?:OpenCode|OpenCode Desktop)(?:\.exe)?$' -or $p.CommandLine -match '[\\/]opencode-ai[\\/]') { $clients.opencode = $true }
  if ($p.Name -match '^Codex(?:\.exe)?$' -or $p.CommandLine -match '[\\/]@openai[\\/]codex[\\/]') {
    $clients.codex = $true
    $clients.codexWriters += $p.ExecutablePath
  }
}
$clients | ConvertTo-Json -Compress`;
 return new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,ENTROTECT_WORKER_PID:String(process.pid)},windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',error='';const timer=setTimeout(()=>{child.kill();reject(Error('检查独立客户端状态超时，已暂缓自动写回'));},10_000);child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>error+=s);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error('无法确认独立客户端状态，已暂缓自动写回'));try{resolve(JSON.parse(out));}catch{reject(Error('独立客户端状态无效，已暂缓自动写回'));}});});
}
