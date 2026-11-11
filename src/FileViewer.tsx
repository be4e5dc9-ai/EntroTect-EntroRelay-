import { useI18n, type Translate } from './i18n';
import { memo, useLayoutEffect, useRef, useState } from 'react';
import { FileCode2, FileDiff, FolderOpen, Image, Maximize2, X } from 'lucide-react';
import type { DiffPreview, FilePreview } from '../shared/types';
import type { FileReference } from '../shared/preview-link';
import { api, message } from './api';

export type Preview = { kind: 'file'; data: FilePreview; reference?: FileReference } | { kind: 'diff'; data: DiffPreview };
const sizeFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });

export function FileViewer({ preview, onClose, inline, onExpand }: {
  preview: Preview; onClose(): void; inline: boolean; onExpand(): void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const viewer = useRef<HTMLDivElement>(null);
  const [openError, setOpenError] = useState<{ path: string; message: string }>();
  useLayoutEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); };
  }, [inline]);
  useLayoutEffect(() => {
    const container = viewer.current;
    const selection = container?.querySelector('.source-selection');
    if (container && selection) {
      container.scrollTop += selection.getBoundingClientRect().top - container.getBoundingClientRect().top
        - container.clientHeight / 4;
    }
  }, [preview, inline]);
  const { data } = preview;
  const reference = preview.kind === 'file' ? preview.reference : undefined;
  const location = reference?.line ? lineLabel(t, reference.line, reference.endLine) : '';
  const name = data.path.split('/').at(-1) || data.path;
  const label = preview.kind === 'diff' ? t("更改预览") : t("文件预览");
  const icon = preview.kind === 'diff' ? <FileDiff size={16}/> : preview.data.image ? <Image size={16}/> : <FileCode2 size={16}/>;
  const size = preview.kind === 'diff' ? t("Git 差异") : preview.data.size < 1024 ? `${preview.data.size} B` : `${sizeFormat.format(preview.data.size / 1024)} KB`;
  const content = <section className={`file-viewer ${inline ? 'file-viewer-inline' : ''}`} role={inline ? 'region' : undefined} aria-label={inline ? label : undefined}>
    <header>
      <div>{icon}<strong title={data.path}>{name}</strong>{!inline && <span>{label}</span>}</div>
      {inline && <button className="icon-button" data-expand-preview title={t("展开文件预览")} onClick={onExpand}><Maximize2 size={14}/></button>}
      <button className="icon-button" title={inline && preview.kind === 'file' ? t("返回文件列表") : t("关闭文件预览")} onClick={onClose}><X size={16}/></button>
    </header>
    <div className="file-viewer-path">
      <span title={data.path}>{data.path}</span>
      {location && <small>{location}</small>}
      <button title={t("打开文件所在目录")} aria-label={t("打开文件所在目录")}
        onClick={() => {
          setOpenError(undefined);
          void api?.openPath(data.parent).catch(error => setOpenError({ path: data.path, message: message(error) }));
        }}>
        <FolderOpen size={14}/>{!inline && t("打开所在目录")}
      </button>
    </div>
    {openError?.path === data.path && <div className="project-error" role="alert">{openError.message}</div>}
    {data.truncated && <div className="file-truncated">
      {preview.kind === 'file' && preview.data.binary ? t("文件过大，无法在侧栏预览。") : t("内容较大，预览已截断。")}
    </div>}
    <div ref={viewer} className="file-viewer-content" key={data.path}><PreviewContent preview={preview} name={name}/></div>
    <footer><span>{size}{" "}{t("· 只读")}</span>{!inline && <span>{t("Esc 关闭")}</span>}</footer>
  </section>;
  return inline ? content : <dialog ref={dialog} className="file-preview-dialog" aria-label={label}
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    {content}
  </dialog>;
}

function lineLabel(t: Translate, line: number, endLine?: number) {
  return t("第 {0}{1} 行", line, endLine && endLine > line ? `–${endLine}` : '');
}

const PreviewContent = memo(function PreviewContent({ preview, name }: { preview: Preview; name: string }) {
  const { t } = useI18n();
  if (preview.kind === 'diff') {
    const { staged, unstaged } = preview.data;
    return <>
      {staged && <DiffBlock label={t("已暂存的改动")} text={staged}/>}
      {unstaged && <DiffBlock label={staged ? t("未暂存的改动") : t("工作区改动")} text={unstaged}/>}
      {!staged && !unstaged && <div className="file-unsupported"><p>{t("没有可显示的文本差异")}</p></div>}
    </>;
  }
  const { image, binary, text } = preview.data;
  if (image) return <ImagePreview image={image} name={name}/>;
  if (binary) return <div className="file-unsupported">
    <FileCode2 size={24}/><p>{t("此文件无法显示为文本或图片")}</p><span>{t("可在文件所在目录使用其他应用打开")}</span>
  </div>;
  const lines = text.split('\n');
  const numbers = lines.map((_, index) => index + 1).join('\n');
  if (!lines.at(-1)) lines[lines.length - 1] = ' ';
  const start = preview.reference?.line;
  const end = Math.min(preview.reference?.endLine ?? start ?? 0, lines.length);
  return <>{start && start > lines.length && <div className="file-truncated" role="status">
    {preview.data.truncated ? t("引用行超出预览范围。") : t("文件中没有该行。")}
  </div>}<div className="source-lines">
    <pre className="source-gutter" aria-hidden="true">{numbers}</pre>
    <pre className="source-code">{start && start <= lines.length ? <>
      {start > 1 && lines.slice(0, start - 1).join('\n') + '\n'}
      <mark className="source-selection" aria-label={lineLabel(t, start, end)}>{lines.slice(start - 1, end).join('\n') || ' '}</mark>
      {end < lines.length && '\n' + lines.slice(end).join('\n')}
    </> : lines.join('\n')}</pre>
  </div></>;
});

function ImagePreview({ image, name }: { image: NonNullable<FilePreview['image']>; name: string }) {
  const { t } = useI18n();
  const src = `data:${image.mime};base64,${image.base64}`;
  const [failedSrc, setFailedSrc] = useState('');
  if (failedSrc === src) return <div className="file-unsupported"><Image size={24}/><p>{t("图片无法读取")}</p><span>{t("可在文件所在目录使用其他应用打开")}</span></div>;
  return <div className="image-preview"><img src={src} alt={name} decoding="async" draggable={false} onError={() => setFailedSrc(src)}/></div>;
}

function diffStyle(line: string) {
  if (/^(\+\+\+|---|diff |index )/.test(line)) return 'diff-meta';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-remove';
  if (line.startsWith('@@')) return 'diff-hunk';
  return '';
}
function DiffBlock({ label, text }: { label: string; text: string }) {
  const groups: { style: string; lines: string[] }[] = [];
  for (const line of text.replace(/\n$/, '').split('\n')) {
    const style = diffStyle(line);
    const previous = groups.at(-1);
    if (previous?.style === style && style !== 'diff-hunk') previous.lines.push(line || ' ');
    else groups.push({ style, lines: [line || ' '] });
  }
  return <section className="diff-block"><h3>{label}</h3><div>
    {groups.map(({ style, lines }, index) => <div className={`diff-line ${style}`} key={index}>
      <span aria-hidden="true">{style === 'diff-hunk' ? '…' : ''}</span><code>{lines.join('\n')}</code>
    </div>)}
  </div></section>;
}
