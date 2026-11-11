import ReactMarkdown, { defaultUrlTransform, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { inlinePreviewLink, previewLink } from '../shared/preview-link';

const fileAnchor = '#preview-file/';

type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] };

function remarkPreviewLinks() {
  function visit(node: MarkdownNode) {
    if (node.type === 'link' || node.type === 'linkReference') return;
    node.children?.forEach((child, index, children) => {
      if (child.type === 'inlineCode' && child.value && inlinePreviewLink(child.value)) {
        children[index] = { type: 'link', url: child.value, children: [child] };
      } else {
        visit(child);
      }
    });
  }
  return visit;
}

const plugins = [remarkGfm, remarkPreviewLinks];
const transform: UrlTransform = (url, key) => {
  if (key !== 'href') return defaultUrlTransform(url);
  const target = previewLink(url);
  if (target?.kind === 'web') return target.url;
  if (target?.kind === 'file') return fileAnchor + encodeURIComponent(url);
  return '';
};

export function chatPreviewLink(href: string) {
  if (!href) return;
  if (!href.startsWith(fileAnchor)) return previewLink(href);
  try { return previewLink(decodeURIComponent(href.slice(fileAnchor.length))); } catch { return; }
}

export function ChatMarkdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={plugins} urlTransform={transform} components={{
    a: ({ node: _node, href, children, ...props }) => href
      ? <a href={href} {...props}>{children}</a>
      : <>{children}</>,
  }}>{text}</ReactMarkdown>;
}
