export type FileReference = { path: string; line?: number; endLine?: number };
export type PreviewLink = { kind: 'file'; reference: FileReference } | { kind: 'web'; url: string };

const loopbackAddress = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|[/?#]|$)/i;
const loopbackWithPort = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]):\d+(?:[/?#]|$)/i;
const namedProjectFile = /^(?:Dockerfile|Makefile|README|LICENSE)(?=[:.]|$)/i;

export function webAddress(input: string, allowBareHost = false) {
  const value = input.trim();
  const bareHost = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:]+\]|[^\s/:]+\.[^\s/:]+)(?::\d+)?(?:[/?#]|$)/i;
  const candidate = allowBareHost && bareHost.test(value) && !value.includes('://')
    ? `${loopbackAddress.test(value) ? 'http' : 'https'}://${value}`
    : value;
  try {
    const url = new URL(candidate);
    if (['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password) return url.href;
  } catch {}
}

function fileLocation(value: string): FileReference | undefined {
  const fileUrl = /^file:\/\//i.test(value);
  let pathname = value;
  let hash = '';
  if (fileUrl) {
    try {
      const url = new URL(value);
      pathname = url.hostname && url.hostname !== 'localhost' ? `//${url.hostname}${url.pathname}` : url.pathname;
      hash = url.hash;
    } catch { return; }
  } else {
    const fragment = value.indexOf('#');
    if (fragment >= 0) {
      pathname = value.slice(0, fragment);
      hash = value.slice(fragment);
    }
  }
  try { pathname = decodeURIComponent(pathname); } catch { if (fileUrl) return; }
  pathname = pathname.replace(/^\/(?=[a-z]:[/\\])/i, '');
  const suffix = pathname.match(/:(\d+)(?::\d+)?$/);
  const fragment = hash.match(/^#L?(\d+)(?:-L?(\d+))?$/i);
  if (hash && !fragment) return;
  if (suffix) pathname = pathname.slice(0, -suffix[0].length);
  if (!pathname || /[\0\r\n?]/.test(pathname) || pathname.replace(/^[a-z]:(?=[/\\])/i, '').includes(':')) return;
  const line = Number(fragment?.[1] ?? suffix?.[1]);
  const endLine = Number(fragment?.[2]);
  return { path: pathname, ...(Number.isSafeInteger(line) && line > 0 && { line }),
    ...(Number.isSafeInteger(endLine) && endLine >= line && { endLine }) };
}

export function previewLink(href: string): PreviewLink | undefined {
  const value = href.trim();
  if (/^https?:/i.test(value) || loopbackWithPort.test(value)) {
    const url = webAddress(value, true);
    return url ? { kind: 'web', url } : undefined;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)
    && !/^(?:[a-z]:[/\\]|file:\/\/)/i.test(value)
    && !/^[^/:\\]+\.[^/:\\]+:\d+(?::\d+)?(?:#.*)?$/.test(value)
    && !namedProjectFile.test(value)) return;
  const reference = fileLocation(value);
  if (reference) return { kind: 'file', reference };
}

export function inlinePreviewLink(value: string) {
  const target = previewLink(value);
  if (target?.kind === 'web') return target;
  if (target?.kind !== 'file') return;
  const { path, line } = target.reference;
  if (line || /[/\\]/.test(path) && /(?:\.[\w-]+|[/\\](?:Dockerfile|Makefile))$/i.test(path)
    || /^[^\s/\\]+\.(?:md|txt|json|jsonl|toml|ya?ml|ts|tsx|js|jsx|rs|py|css|html|sql|go|java|cpp|cs|png|jpe?g|webp)$/i.test(path)
    || namedProjectFile.test(path)) return target;
}
