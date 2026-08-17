/**
 * TVAgent — поверхность разговора.
 *
 * Гоняет настоящий panel-chat.js под самодельным DOM. Проверяет то, что
 * дорого сломать: экранирование того, что реально приходит от модели
 * (имя инструмента, его вход, текст ошибки), и схлопывание вызовов одного
 * рана в одну строку "N actions" вместо трёх поднятых коробок.
 *
 * innerHTML — это много, чтобы честно подделать. Подделка ниже включает
 * настоящий (хоть и маленький) HTML-парсер: для того набора тегов, что
 * реально пишет panel-chat.js (div/span/pre/code/details/summary/button/b,
 * простые атрибуты в двойных кавычках, без вложенных кавычек — они и не
 * появляются, потому что весь пользовательский текст уже проходит esc()
 * раньше, чем попасть в шаблон), он строит настоящее дерево, а не плоскую
 * запись строки. Без этого тест на экранирование был бы теми же тремя
 * похожими на зелёный светофор подделками, что уже трижды прятали дефект
 * в этом плане: строка "выглядит безопасной" ничего не говорит о том,
 * получился ли из неё <img onerror> живым элементом или мёртвым текстом.
 *
 * Что подделка моделирует по-настоящему:
 *   - innerHTML-парсинг вложенных тегов с атрибутами (включая булевы вроде
 *     data-yes) и декодирование ровно тех пяти сущностей, что производит
 *     esc() — то есть то, что реальный браузер сделал бы с этой самой
 *     escaped-строкой;
 *   - querySelector/querySelectorAll по одному классу или по [attr] —
 *     обходом потомков в document order, как настоящий DOM, а не поиском
 *     по плоскому реестру;
 *   - textContent — конкатенация текстовых узлов на чтение, замена детей
 *     одним текстовым узлом на запись (в т.ч. `+=`);
 *   - classList.add/contains, вычисляемый по текущему className, а не
 *     отдельный Set, который может разойтись с ним;
 *   - appendChild с настоящей семантикой переноса (снимает со старого
 *     родителя) и remove().
 *
 * Что НЕ моделирует (и не должно вводить в заблуждение):
 *   - CSS-селекторы сложнее одного класса или одного [attr] — модуль их и
 *     не использует, попытка научить им подделку добавила бы код, который
 *     никогда не проверяется;
 *   - самозакрывающиеся/void-теги (<br>, <img> как реальный элемент) —
 *     они и не встречаются в шаблонах этого модуля как теги: если модель
 *     пришлёт литерал "<img ...>" в имени инструмента, он обязан остаться
 *     текстом после esc(), а не стать тегом, что тест и проверяет;
 *   - HTML-комментарии, CDATA, самозакрытие через "/>" — не нужны для
 *     этого набора шаблонов;
 *   - постоянную идентичность innerHTML на чтение (геттер не реализован
 *     как точная сериализация с учётом кавычек и т.п.) — модуль его и не
 *     читает, только пишет.
 *
 *   node chat-test.mjs
 */
import fs from 'node:fs';

const src = fs.readFileSync(
  new URL('./extension/src/content/panel-chat.js', import.meta.url).pathname,
  'utf8'
);

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? ' ok  ' : ' FAIL'} ${name}` +
      (ok ? '' : `\n        получили ${JSON.stringify(got)}\n        ждали    ${JSON.stringify(want)}`)
  );
}

// ------------------------------------------------------------------ DOM

const ENTITY_BACK = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ENTITY_BACK[e]);
}

function matchesSel(node, sel) {
  if (!node || node.nodeType !== 'element') return false;
  if (sel[0] === '.') {
    const cls = sel.slice(1);
    return (node.className || '').split(/\s+/).filter(Boolean).includes(cls);
  }
  if (sel[0] === '[' && sel[sel.length - 1] === ']') {
    return Object.prototype.hasOwnProperty.call(node.attrs, sel.slice(1, -1));
  }
  throw new Error('fake querySelector: unsupported selector ' + sel);
}

function descendants(node) {
  const out = [];
  for (const c of node.children) {
    out.push(c);
    if (c.nodeType === 'element') out.push(...descendants(c));
  }
  return out;
}

function textOf(node) {
  if (node.nodeType === 'text') return node.text;
  return node.children.map(textOf).join('');
}

/**
 * Парсит фрагмент HTML в список несвязанных узлов (element | text), без
 * привязки к родителю — вызывающий (innerHTML-сеттер или insertAdjacentHTML)
 * сам простёгивает .parent. Тегов из этого набора шаблонов достаточно: все
 * открываются и закрываются явно, самозакрытия не бывает.
 */
function parseFragment(html) {
  const root = { children: [] };
  const stack = [root];
  const tagRe = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[^<>]*)?>/g;
  let last = 0;
  let m;

  const pushText = (raw) => {
    const text = decodeEntities(raw);
    if (text === '') return;
    const container = stack[stack.length - 1];
    const parentEl = container === root ? null : container;
    container.children.push({ nodeType: 'text', text, parent: parentEl });
  };

  while ((m = tagRe.exec(html))) {
    if (m.index > last) pushText(html.slice(last, m.index));
    last = tagRe.lastIndex;
    const tok = m[0];

    if (tok.startsWith('</')) {
      const tagName = tok.slice(2, -1).trim().toUpperCase();
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tagName === tagName) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const mm = /^<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*)?)>$/.exec(tok);
    const el = makeElement(mm[1]);
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g;
    let am;
    while ((am = attrRe.exec(mm[2] || ''))) {
      if (am[1] === 'class') el.className = am[2] || '';
      else el.attrs[am[1]] = am[2] === undefined ? '' : am[2];
    }
    const container = stack[stack.length - 1];
    el.parent = container === root ? null : container;
    container.children.push(el);
    stack.push(el);
  }
  if (last < html.length) pushText(html.slice(last));

  return root.children;
}

function makeElement(tagName) {
  const el = {
    nodeType: 'element',
    tagName: String(tagName).toUpperCase(),
    className: '',
    attrs: {},
    children: [],
    parent: null,
    listeners: {},
    dataset: {},
    open: false,
    scrollTop: 0,
    scrollHeight: 0,

    appendChild(child) {
      if (child.parent) {
        const i = child.parent.children.indexOf(child);
        if (i !== -1) child.parent.children.splice(i, 1);
      }
      child.parent = el;
      el.children.push(child);
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
    querySelector(sel) {
      return descendants(el).find((n) => matchesSel(n, sel)) || null;
    },
    querySelectorAll(sel) {
      return descendants(el).filter((n) => matchesSel(n, sel));
    },
    insertAdjacentHTML(pos, html) {
      if (pos !== 'beforeend') throw new Error('fake insertAdjacentHTML: unsupported position ' + pos);
      parseFragment(html).forEach((n) => {
        n.parent = el;
        el.children.push(n);
      });
    },
  };

  Object.defineProperty(el, 'innerHTML', {
    set(html) {
      el.children = parseFragment(html);
      el.children.forEach((n) => (n.parent = el));
    },
    get() {
      return '[fake: write-only]';
    },
  });
  Object.defineProperty(el, 'textContent', {
    get() {
      return textOf(el);
    },
    set(v) {
      el.children = [{ nodeType: 'text', text: String(v), parent: el }];
    },
  });
  Object.defineProperty(el, 'classList', {
    get() {
      const parts = () => (el.className || '').split(/\s+/).filter(Boolean);
      return {
        contains: (c) => parts().includes(c),
        add: (...cs) => {
          const s = new Set(parts());
          cs.forEach((c) => s.add(c));
          el.className = [...s].join(' ');
        },
        remove: (...cs) => {
          const s = new Set(parts());
          cs.forEach((c) => s.delete(c));
          el.className = [...s].join(' ');
        },
      };
    },
  });

  return el;
}

function makeDocument() {
  return { createElement: (tag) => makeElement(tag) };
}

/** Симулирует клик, как настоящий addEventListener('click', ...) бы его доставил. */
function click(el) {
  (el.listeners.click || []).forEach((fn) => fn({}));
}

function load(win, doc) {
  new Function('window', 'document', src)(win, doc);
  return win.TVAgentChat;
}

// Ни один элемент дерева не должен оказаться тегом, которого не было в
// шаблоне модуля — это и есть проверка того, что XSS-полезная нагрузка
// осталась текстом, а не стала живым узлом.
const DANGEROUS_TAGS = ['IMG', 'SCRIPT', 'IFRAME', 'A', 'STYLE', 'INPUT'];
function findDangerousTag(root) {
  return descendants(root).find((n) => n.nodeType === 'element' && DANGEROUS_TAGS.includes(n.tagName));
}
function findTag(root, tagName) {
  const want = tagName.toUpperCase();
  return descendants(root).find((n) => n.nodeType === 'element' && n.tagName === want);
}

// -------------------------------------------------------------- esc()

console.log('\n— esc() —');

{
  const doc = makeDocument();
  const Chat = load({}, doc);

  check('esc: &', Chat.esc('&'), '&amp;');
  check('esc: <', Chat.esc('<'), '&lt;');
  check('esc: >', Chat.esc('>'), '&gt;');
  check('esc: "', Chat.esc('"'), '&quot;');
  check("esc: '", Chat.esc("'"), '&#39;');
  check('esc: все пять сразу', Chat.esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  check('esc: обычный текст не трогает', Chat.esc('EMA 50/200'), 'EMA 50/200');
}

// ---------------------------------------------------------- renderText()

console.log('\n— renderText() —');

{
  const doc = makeDocument();
  const Chat = load({}, doc);

  check(
    'fenced-блок с языком: язык срезан, тело экранировано',
    Chat.renderText('```js\nconsole.log(1)\n```'),
    '<pre><code>console.log(1)\n</code></pre>'
  );

  check(
    'незакрытый fence всё равно уходит в code-блок (чётность по счётчику ```, не по закрывающей паре)',
    Chat.renderText('```abc'),
    '<pre><code>abc</code></pre>'
  );

  check(
    'инлайн-код: обычный текст экранирован, `x` обёрнут в <code>',
    Chat.renderText('5 < 6 and `x` > 1'),
    '5 &lt; 6 and <code>x</code> &gt; 1'
  );

  check(
    '< внутри fence экранирован, а не стал тегом',
    Chat.renderText('```\n<script>\n```'),
    '<pre><code>&lt;script&gt;\n</code></pre>'
  );

  check(
    'текст без языковой метки: пустой lang-префикс не съедает первую строку кода',
    Chat.renderText('```\nplain\n```'),
    '<pre><code>plain\n</code></pre>'
  );
}

// -------------------------------------------------------- экранирование в DOM

console.log('\n— то, что реально приходит от модели, не долетает до DOM как теги —');

{
  const doc = makeDocument();
  const Chat = load({}, doc);
  const listEl = doc.createElement('div');
  const chat = Chat.create(listEl);

  const evilName = '<img src=x onerror=alert(1)>';
  const evilInput = { note: 'she said "hi" <script>alert(1)</script>' };
  chat.onToolStart({ id: 't1', name: evilName, input: evilInput });

  check('вредоносное имя инструмента не породило <img>/<script> узел', findDangerousTag(listEl), undefined);
  check(
    'имя инструмента отображается как исходный текст (сущности раскодировались обратно)',
    listEl.querySelector('.tva-call-name').textContent,
    evilName
  );
  check(
    'вход с кавычкой и <script> тоже остался текстом внутри <pre>',
    listEl.querySelector('.tva-call-body').textContent,
    JSON.stringify(evilInput, null, 2)
  );
}

{
  const doc = makeDocument();
  const Chat = load({}, doc);
  const listEl = doc.createElement('div');
  const chat = Chat.create(listEl);

  const evilError = '<b>bold</b> & "quoted" <iframe src=evil>';
  const el = chat.error(evilError);

  check('текст ошибки с разметкой не породил ни одного тега', findDangerousTag(listEl), undefined);
  check('и не породил <b> — тег из чужого шаблона (confirm), а не error', findTag(listEl, 'b'), undefined);
  check('в узле только текст, без дочерних элементов', el.children.every((c) => c.nodeType === 'text'), true);
  check('текст ошибки виден как есть', el.textContent, evilError);
}

// --------------------------------------------------------- схлопывание рана

console.log('\n— один run на N вызовов, а не N деталей —');

{
  const doc = makeDocument();
  const Chat = load({}, doc);
  const listEl = doc.createElement('div');
  const chat = Chat.create(listEl);

  chat.startRun();
  chat.onToolStart({ id: 'a', name: 'get_chart', input: {} });
  chat.onToolStart({ id: 'b', name: 'set_symbol', input: { symbol: 'BTCUSD' } });
  chat.onToolStart({ id: 'c', name: 'add_indicator', input: { name: 'EMA' } });

  check('три onToolStart — одна строка .tva-run, не три', listEl.querySelectorAll('.tva-run').length, 1);
  check('внутри неё три .tva-call', listEl.querySelectorAll('.tva-call').length, 3);
  check('подпись — "3 actions"', listEl.querySelector('.tva-run-label').textContent, '3 actions');
}

{
  const doc = makeDocument();
  const Chat = load({}, doc);
  const listEl = doc.createElement('div');
  const chat = Chat.create(listEl);

  chat.startRun();
  chat.onToolStart({ id: 'a', name: 'get_chart', input: {} });

  check('один вызов — "1 action", единственное число', listEl.querySelector('.tva-run-label').textContent, '1 action');
}

// -------------------------------------------------------------- onToolResult

console.log('\n— onToolResult —');

{
  const doc = makeDocument();
  const Chat = load({}, doc);
  const listEl = doc.createElement('div');
  const chat = Chat.create(listEl);

  chat.startRun();
  chat.onToolStart({ id: 'f', name: 'edit_pine', input: {} });
  chat.onToolResult({ id: 'f', ok: false, result: 'boom' });

  const run = listEl.querySelector('.tva-run');
  check('провал открывает строку рана', run.open, true);
  check('статус вызова помечен failed', listEl.querySelector('.tva-call-status').textContent, 'failed');
}

{
  const doc = makeDocument();
  const Chat = load({}, doc);
  const listEl = doc.createElement('div');
  const chat = Chat.create(listEl);

  chat.startRun();
  chat.onToolStart({ id: 's', name: 'get_chart', input: {} });
  chat.onToolResult({ id: 's', ok: true, result: 'fine' });

  const run = listEl.querySelector('.tva-run');
  check('успех не открывает строку рана', run.open, false);
  check('статус вызова помечен done', listEl.querySelector('.tva-call-status').textContent, 'done');
}

{
  const doc = makeDocument();
  const Chat = load({}, doc);
  const listEl = doc.createElement('div');
  const chat = Chat.create(listEl);

  chat.startRun();
  chat.onToolStart({ id: 'known', name: 'get_chart', input: {} });

  let threw = false;
  try {
    chat.onToolResult({ id: 'unknown-id', ok: true, result: 'z' });
  } catch (e) {
    threw = true;
  }
  check('результат на неизвестный id — no-op, не бросает', threw, false);
  check('исходный вызов остался нетронут (всё ещё pending)', listEl.querySelector('.tva-call-status').textContent, 'running…');
}

// ----------------------------------------------------------------- lifecycle

console.log('\n— жизненный цикл: startRun / endRun / clear —');

{
  const doc = makeDocument();
  const Chat = load({}, doc);
  const listEl = doc.createElement('div');
  const chat = Chat.create(listEl);

  chat.startRun();
  chat.onToolStart({ id: 'a', name: 'first', input: {} });
  chat.endRun();

  chat.startRun();
  chat.onToolStart({ id: 'b', name: 'second', input: {} });
  chat.endRun();

  check('два рана подряд — две отдельные строки', listEl.querySelectorAll('.tva-run').length, 2);
  const labels = listEl.querySelectorAll('.tva-run-label').map((n) => n.textContent);
  check('у каждого своя метка "1 action", счётчик не накопился со старого рана', labels, ['1 action', '1 action']);
  const marks = listEl.querySelectorAll('.tva-run-mark');
  check('оба рана завершены (mark получил класс done)', marks.every((m) => m.classList.contains('done')), true);
}

{
  const doc = makeDocument();
  const Chat = load({}, doc);
  const listEl = doc.createElement('div');
  const chat = Chat.create(listEl);

  // Деliberately no endRun() here: clear() has to reset runEl itself, not
  // rely on endRun having already done it. This is the scenario that
  // matters — "Clear conversation" clicked while the agent is mid-run.
  chat.startRun();
  chat.onToolStart({ id: 'a', name: 'first', input: {} });
  chat.clear();
  check('clear() опустошает список даже посреди рана', listEl.children.length, 0);

  // Настоящая опасность здесь — не пустой список, а забытая ссылка на
  // старый (уже отсоединённый) runEl: тогда следующий onToolStart решит,
  // что run уже есть, попробует дописать в отсоединённое поддерево, и
  // новая строка в listEl не появится вовсе.
  chat.onToolStart({ id: 'c', name: 'third', input: {} });
  check('после clear() новый вызов создаёт свежий run, а не молчит', listEl.querySelectorAll('.tva-run').length, 1);
  check('и в нём ровно один action', listEl.querySelector('.tva-run-label').textContent, '1 action');
}

// -------------------------------------------------------------- onConfirm

console.log('\n— onConfirm —');

{
  const doc = makeDocument();
  const Chat = load({}, doc);
  const listEl = doc.createElement('div');
  const chat = Chat.create(listEl);

  const promise = chat.onConfirm({ name: 'edit_pine_script', input: { code: 'strategy()' } });
  const confirmEl = listEl.querySelector('.tva-confirm-head').parent;

  check('кнопки на месте до ответа', confirmEl.querySelector('.tva-confirm-actions') !== null, true);
  click(confirmEl.querySelector('[data-yes]'));

  const allowed = await promise;
  check('Allow резолвит промис в true', allowed, true);
  check('кнопки убраны после ответа', confirmEl.querySelector('.tva-confirm-actions'), null);
  check('добавлен текст исхода "Allowed"', confirmEl.querySelector('.tva-confirm-outcome').textContent, 'Allowed');
}

{
  const doc = makeDocument();
  const Chat = load({}, doc);
  const listEl = doc.createElement('div');
  const chat = Chat.create(listEl);

  const promise = chat.onConfirm({ name: 'edit_pine_script', input: { code: 'strategy()' } });
  const confirmEl = listEl.querySelector('.tva-confirm-head').parent;
  click(confirmEl.querySelector('[data-no]'));

  const allowed = await promise;
  check('Deny резолвит промис в false', allowed, false);
  check('кнопки убраны после ответа', confirmEl.querySelector('.tva-confirm-actions'), null);
  check('добавлен текст исхода "Denied"', confirmEl.querySelector('.tva-confirm-outcome').textContent, 'Denied');
}

console.log(failed ? `\n${failed} провалов\n` : '\nвсё зелёное\n');
process.exit(failed ? 1 : 0);
