/**
 * TVAgent tests — a small, honest DOM.
 *
 * Four test files each grew their own copy of this, and they had already
 * drifted: one decoded HTML entities and two did not, one bubbled clicks and
 * two did not, one kept `disabled` as a property and the others lost it. A
 * fake that disagrees with itself between files is worse than no fake at all,
 * because each file looks green against its own dialect.
 *
 * What this models for real, because the tests depend on it:
 *
 *   - innerHTML parsing of nested tags with attributes (including boolean ones
 *     like `data-yes`) and decoding of exactly the five entities esc()
 *     produces — that is, what a browser would do with that same escaped
 *     string. Without it, an escaping test proves nothing: a string that
 *     "looks safe" says nothing about whether `<img onerror>` came out of it
 *     as a live element or as dead text;
 *   - querySelector/querySelectorAll for one compound selector — tag, #id,
 *     .class, [attr] — by walking descendants in document order, like a real
 *     DOM, rather than consulting a flat registry;
 *   - textContent: concatenated text nodes on read, one replacement text node
 *     on write (so `+=` behaves);
 *   - classList computed from className rather than kept in a parallel Set
 *     that can disagree with it;
 *   - appendChild with real move semantics (it detaches from the old parent)
 *     and remove();
 *   - closed shadow roots: attachShadow({mode:'closed'}) leaves
 *     `el.shadowRoot` null, which is the whole point of the API and the thing
 *     the settings test has to be able to observe.
 *
 * What it does NOT model, and must not be read as covering:
 *
 *   - selectors with descendant/child combinators — no module here writes one;
 *   - self-closing syntax ("<br/>"), comments, CDATA;
 *   - innerHTML as a getter (nothing reads it back; it is write-only here).
 */

const VOID_TAGS = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);

// Exactly the five that panel-chat.js's esc() produces, and no more.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

const decodeEntities = (s) =>
  s.replace(/&(amp|lt|gt|quot|#39);/g, (whole, name) =>
    ENTITIES[name] === undefined ? whole : ENTITIES[name]
  );

export function descendants(node) {
  const out = [];
  for (const c of node.children) {
    out.push(c);
    if (c.nodeType === 'element') out.push(...descendants(c));
  }
  return out;
}

export function textOf(node) {
  if (node.nodeType === 'text') return node.text;
  return node.children.map(textOf).join('');
}

function computeDataset(el) {
  el.dataset = {};
  for (const [k, v] of Object.entries(el.attrs)) {
    if (!k.startsWith('data-')) continue;
    const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    el.dataset[camel] = v;
  }
}

/** One compound selector link: tag?, #id?, .class*, [attr]* — no whitespace. */
export function matchesSel(node, sel) {
  if (!node || node.nodeType !== 'element') return false;
  let rest = sel;
  const tagM = rest.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tagM) {
    if (node.tagName !== tagM[0].toUpperCase()) return false;
    rest = rest.slice(tagM[0].length);
  }
  const idM = rest.match(/#([\w-]+)/);
  if (idM && node.id !== idM[1]) return false;
  for (const c of rest.match(/\.[\w-]+/g) || []) {
    if (!(node.className || '').split(/\s+/).filter(Boolean).includes(c.slice(1))) return false;
  }
  for (const a of rest.match(/\[[\w-]+\]/g) || []) {
    if (!(a.slice(1, -1) in node.attrs)) return false;
  }
  return true;
}

function makeClassList(el) {
  const parts = () => (el.className || '').split(/\s+/).filter(Boolean);
  const write = (set) => (el.className = [...set].join(' '));
  return {
    contains: (c) => parts().includes(c),
    add: (...cs) => { const s = new Set(parts()); cs.forEach((c) => s.add(c)); write(s); },
    remove: (...cs) => { const s = new Set(parts()); cs.forEach((c) => s.delete(c)); write(s); },
    toggle: (c, force) => {
      const has = parts().includes(c);
      const want = force === undefined ? !has : !!force;
      if (want !== has) {
        const s = new Set(parts());
        want ? s.add(c) : s.delete(c);
        write(s);
      }
      return want;
    },
  };
}

export function parseFragment(html) {
  const root = { children: [] };
  const stack = [root];
  const tagRe = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[^<>]*)?>/g;
  let last = 0;
  let m;

  const pushText = (raw) => {
    if (raw === '') return;
    const container = stack[stack.length - 1];
    container.children.push({
      nodeType: 'text',
      text: decodeEntities(raw),
      parent: container === root ? null : container,
    });
  };

  while ((m = tagRe.exec(html))) {
    if (m.index > last) pushText(html.slice(last, m.index));
    last = tagRe.lastIndex;
    const tok = m[0];

    if (tok.startsWith('</')) {
      const tagName = tok.slice(2, -1).trim().toUpperCase();
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tagName === tagName) { stack.length = i; break; }
      }
      continue;
    }

    const mm = /^<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*)?)>$/.exec(tok);
    const tagName = mm[1];
    const el = makeElement(tagName);
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g;
    let am;
    while ((am = attrRe.exec(mm[2] || ''))) {
      if (am[1] === 'class') el.className = am[2] || '';
      else el.attrs[am[1]] = am[2] === undefined ? '' : decodeEntities(am[2]);
    }
    computeDataset(el);
    if (el.attrs.id) el.id = el.attrs.id;
    // A boolean `disabled` in markup is the starting state of the `.disabled`
    // property, exactly as in a real DOM. Only the send button has one.
    if ('disabled' in el.attrs) el.disabled = true;

    const container = stack[stack.length - 1];
    el.parent = container === root ? null : container;
    container.children.push(el);

    if (!VOID_TAGS.has(tagName.toLowerCase())) stack.push(el);
  }
  if (last < html.length) pushText(html.slice(last));

  return root.children;
}

export function makeElement(tagName) {
  const el = {
    nodeType: 'element',
    tagName: String(tagName).toUpperCase(),
    id: '',
    className: '',
    attrs: {},
    dataset: {},
    children: [],
    parent: null,
    listeners: {},
    value: '',
    placeholder: '',
    checked: false,
    disabled: false,
    // <details> starts folded, like the real one.
    open: false,
    style: {},
    scrollHeight: 0,
    scrollTop: 0,
    shadowRoot: null,
    _focusCount: 0,

    appendChild(child) {
      if (child.parent) {
        const i = child.parent.children.indexOf(child);
        if (i !== -1) child.parent.children.splice(i, 1);
      }
      child.parent = el;
      el.children.push(child);
      return child;
    },
    insertBefore(child, before) {
      if (child.parent) {
        const i = child.parent.children.indexOf(child);
        if (i !== -1) child.parent.children.splice(i, 1);
      }
      child.parent = el;
      const at = before ? el.children.indexOf(before) : -1;
      if (at === -1) el.children.push(child);
      else el.children.splice(at, 0, child);
      return child;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i !== -1) el.children.splice(i, 1);
      child.parent = null;
      return child;
    },
    remove() {
      if (el.parent) {
        const i = el.parent.children.indexOf(el);
        if (i !== -1) el.parent.children.splice(i, 1);
      }
      el.parent = null;
    },
    addEventListener(type, fn) {
      (el.listeners[type] = el.listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = el.listeners[type] || [];
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    },
    querySelector(sel) {
      return descendants(el).find((n) => matchesSel(n, sel)) || null;
    },
    querySelectorAll(sel) {
      return descendants(el).filter((n) => matchesSel(n, sel));
    },
    closest(sel) {
      let n = el;
      while (n && n.nodeType === 'element') {
        if (matchesSel(n, sel)) return n;
        n = n.parent;
      }
      return null;
    },
    insertAdjacentHTML(pos, html) {
      if (pos !== 'beforeend') throw new Error('fake insertAdjacentHTML: unsupported position ' + pos);
      parseFragment(html).forEach((n) => {
        n.parent = el;
        el.children.push(n);
      });
    },
    setAttribute(name, value) {
      el.attrs[name] = value;
      if (name.startsWith('data-')) computeDataset(el);
    },
    getAttribute(name) {
      return el.attrs[name] === undefined ? null : el.attrs[name];
    },
    /**
     * A closed root is unreachable from the element, which is exactly what
     * the panel relies on for the API key fields. The tree is returned to the
     * caller and to nobody else.
     */
    attachShadow({ mode }) {
      const root = makeElement('#shadow-root');
      root.host = el;
      if (mode !== 'closed') el.shadowRoot = root;
      // A test has to be able to look inside; a page script must not. The
      // real API's answer — `shadowRoot` — stays null above, and this is a
      // named seam the DOM itself hands out, which is a thing only the code
      // that owns the DOM can do.
      el._shadowRootForTests = root;
      return root;
    },
    contains(node) {
      return node === el || descendants(el).includes(node);
    },
    focus() {
      el._focusCount++;
    },
  };

  Object.defineProperty(el, 'innerHTML', {
    set(html) {
      el.children = parseFragment(html);
      el.children.forEach((n) => (n.parent = el));
    },
    get() { return '[fake: write-only]'; },
  });
  Object.defineProperty(el, 'textContent', {
    get() { return textOf(el); },
    set(v) { el.children = [{ nodeType: 'text', text: String(v), parent: el }]; },
  });
  Object.defineProperty(el, 'firstChild', {
    get() { return el.children[0] || null; },
  });
  // `title` reflects into the attribute, as in a real DOM: markup sets it as
  // an attribute and code sets it as a property. Two independent stores would
  // mean a test reads something other than what the module wrote.
  Object.defineProperty(el, 'title', {
    get() { return el.attrs.title === undefined ? '' : el.attrs.title; },
    set(v) { el.attrs.title = String(v); },
  });
  Object.defineProperty(el, 'classList', { get: () => makeClassList(el) });

  return el;
}

/**
 * `document`, with a listener registry that keys on the capture flag.
 *
 * The flag is part of the key rather than ignored: in a real DOM,
 * removeEventListener with the other flag removes nothing — a leak — and a
 * fake that forgives it goes green on code that leaks.
 */
export function makeDocument() {
  const listeners = {};
  const key = (type, capture) => `${type}${capture ? '!capture' : ''}`;
  const documentElement = makeElement('html');
  return {
    createElement: (tag) => makeElement(tag),
    documentElement,
    /**
     * Only what is really in the document tree, like the real one: a detached
     * node is not found, however familiar its id.
     */
    getElementById(id) {
      const walk = (n) => {
        if (n.id === id) return n;
        for (const c of n.children) {
          const found = c.nodeType === 'element' ? walk(c) : null;
          if (found) return found;
        }
        return null;
      };
      return walk(documentElement);
    },
    listeners,
    addEventListener(type, fn, capture) {
      const k = key(type, capture);
      (listeners[k] = listeners[k] || []).push(fn);
    },
    removeEventListener(type, fn, capture) {
      const arr = listeners[key(type, capture)] || [];
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    },
    /** How many are attached right now — how removal is verified. */
    listenerCount(type, capture = true) {
      return (listeners[key(type, capture)] || []).length;
    },
    fire(type, evt, capture = true) {
      (listeners[key(type, capture)] || []).slice().forEach((fn) => fn(evt));
    },
  };
}

/** Real bubbling: the element's listeners and every ancestor's, in that order. */
export function click(el) {
  const evt = { target: el };
  let n = el;
  while (n) {
    (n.listeners.click || []).forEach((fn) => fn(evt));
    n = n.parent;
  }
  return evt;
}

export function fireEvent(el, type) {
  const evt = { target: el };
  (el.listeners[type] || []).forEach((fn) => fn(evt));
  return evt;
}

export const fireInput = (el) => fireEvent(el, 'input');
export const fireChange = (el) => fireEvent(el, 'change');

export function fireKeydown(el, { key, shiftKey } = {}) {
  const evt = {
    key,
    shiftKey: !!shiftKey,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  (el.listeners.keydown || []).forEach((fn) => fn(evt));
  return evt;
}

/** First descendant with this tag name — used to prove escaping held. */
export function findTag(root, tagName) {
  return descendants(root).find((n) => n.tagName === tagName.toUpperCase()) || null;
}

const DANGEROUS = ['IMG', 'SCRIPT', 'IFRAME', 'A', 'STYLE'];

/** Anything a successful injection would have produced. */
export function findDangerousTag(root) {
  return descendants(root).find((n) => DANGEROUS.includes(n.tagName)) || null;
}
