export function projectKey(directory: string) {
  return directory.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
}

export function projectName(directory: string) {
  return directory.split(/[\\/]/).filter(Boolean).at(-1) || directory || '未指定目录';
}
