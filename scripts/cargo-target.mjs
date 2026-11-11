import { execFileSync } from 'node:child_process';
export const cargoTarget=JSON.parse(execFileSync('cargo',['metadata','--manifest-path','src-tauri/Cargo.toml','--no-deps','--format-version','1'],{encoding:'utf8',windowsHide:true})).target_directory;
