/**
 * TVAgent — model answers as markdown, built as DOM nodes.
 *
 * markdown-it only parses. Its HTML output is never used: the tokens are
 * turned into elements here, from a fixed list of tags, and every piece of
 * text goes in as a text node. Raw HTML in the answer stays text.
 */
import MarkdownIt, { type Token } from 'markdown-it';

const md = new MarkdownIt('default', { html: false, linkify: true, typographer: false });
// "example.com" is not a link; only a written-out URL is.
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });

const TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'strong',
  'em',
  's',
]);

/**
 * Only https, and never an image: a picture loads by itself, so a model
 * talked into writing one would send whatever is in its URL away unasked.
 */
function safeHref(href: unknown) {
  if (typeof href !== 'string' || !href) return null;
  try {
    return new URL(href).protocol === 'https:' ? href : null;
  } catch {
    return null;
  }
}

function text(parent: Node, content: string) {
  if (content) parent.appendChild(document.createTextNode(content));
}

function opened(token: Token): HTMLElement | null {
  if (token.type === 'link_open') {
    const href = safeHref(token.attrGet('href'));
    if (!href) return null;
    const a = document.createElement('a');
    a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    return a;
  }
  // A paragraph inside a tight list is not drawn as one.
  if (token.hidden || !TAGS.has(token.tag)) return null;
  const el = document.createElement(token.tag);
  const start = token.attrGet('start');
  if (token.tag === 'ol' && start != null && Number.isInteger(Number(start))) {
    el.setAttribute('start', String(Number(start)));
  }
  const align = /text-align:(left|right|center)/.exec(String(token.attrGet('style') ?? ''));
  if (align) el.style.textAlign = align[1];
  return el;
}

/** Appends tokens under `root`. An open without a tag of ours adds no node. */
function build(tokens: Token[], root: Node) {
  const stack: Node[] = [root];
  const top = () => stack[stack.length - 1];
  for (const token of tokens) {
    if (token.nesting === 1) {
      const el = opened(token);
      if (el) top().appendChild(el);
      stack.push(el || top());
    } else if (token.nesting === -1) {
      if (stack.length > 1) stack.pop();
    } else if (token.type === 'inline') {
      build(token.children || [], top());
    } else if (token.type === 'fence' || token.type === 'code_block') {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = token.content;
      pre.appendChild(code);
      top().appendChild(pre);
    } else if (token.type === 'code_inline') {
      const code = document.createElement('code');
      code.textContent = token.content;
      top().appendChild(code);
    } else if (token.type === 'hr' || token.type === 'hardbreak') {
      top().appendChild(document.createElement(token.type === 'hr' ? 'hr' : 'br'));
    } else if (token.type === 'softbreak') {
      text(top(), '\n');
    } else {
      // text, an image's alt, and anything else markdown-it may add later.
      text(top(), token.content);
    }
  }
}

/** One top-level block: its source, which is all its output depends on. */
interface Block {
  key: string;
  tokens: Token[];
}

/** Splits an answer into top-level blocks, so a closed one need not be redrawn. */
function blocks(src: string): Block[] {
  const lines = src.split('\n');
  const out: Block[] = [];
  let current: Token[] = [];
  let map: [number, number] | null = null;
  for (const token of md.parse(src, {})) {
    if (!current.length) map = token.map;
    current.push(token);
    if (token.level === 0 && token.nesting !== 1) {
      const key = map ? lines.slice(map[0], map[1]).join('\n') : '';
      out.push({ key, tokens: current });
      current = [];
    }
  }
  return out;
}

/** One block as a node: its own element, or a wrapper if it made several. */
function render(block: Block): Node {
  const holder = document.createElement('div');
  build(block.tokens, holder);
  return holder.childNodes.length === 1 ? holder.firstChild! : holder;
}

export { blocks, render };
export type { Block };
