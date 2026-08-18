/**
 * TVAgent — настройки провайдера: что реально уходит в запрос и что видно в панели.
 *
 * Гоняет настоящий service-worker.js против поддельного chrome.storage и
 * настоящий panel.css против пути к полю настроек. Проверяет ровно то, что
 * сломалось: выбран OpenAI-совместимый провайдер, а запрос уходит в Anthropic,
 * и поля чужого провайдера остаются на экране.
 *
 *   node settings-test.mjs
 */
import fs from 'node:fs';

const EXT = new URL('./extension/src/', import.meta.url).pathname;
const src = fs.readFileSync(`${EXT}background/service-worker.js`, 'utf8');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? ' ok  ' : ' FAIL'} ${name}${ok ? '' : `\n        получили ${JSON.stringify(got)}\n        ждали    ${JSON.stringify(want)}`}`);
}

// ---- воркер под поддельным chrome ------------------------------------------

/** get() отдаёт только запрошенные ключи — иначе тест не заметит забытый ключ. */
const chromeStub = (data) => ({
  action: { onClicked: { addListener() {} } },
  runtime: { onConnect: { addListener() {} }, onMessage: { addListener() {} } },
  tabs: { sendMessage: () => Promise.resolve() },
  storage: {
    local: {
      get: async (keys) =>
        Object.fromEntries(keys.filter((k) => data[k] !== undefined).map((k) => [k, data[k]])),
    },
  },
});

const load = (data) =>
  new Function(
    'chrome',
    `${src}\nreturn { settings, configError: typeof configError === 'function' ? configError : null };`
  )(chromeStub(data));

console.log('\n— конфиг провайдера —');

{
  const { settings } = load({ provider: 'anthropic', apiKey: 'sk-ant-real', model: 'claude-sonnet-5' });
  const cfg = await settings();
  check('anthropic: свой ключ и своя модель', [cfg.apiKey, cfg.model], ['sk-ant-real', 'claude-sonnet-5']);
}

{
  // Ключ Anthropic лежит в своём слоте и не должен уехать бэрером на чужой хост.
  const { settings } = load({
    provider: 'openai',
    apiKey: 'sk-ant-real',
    model: 'claude-opus-5',
    openaiModel: 'gemma4:26b-a4b-it-qat',
    openaiApiKey: '',
    baseUrl: 'http://localhost:11434/v1',
  });
  const cfg = await settings();
  check('openai: ключ Anthropic не утекает', cfg.apiKey, '');
  check('openai: модель своя, не claude', cfg.model, 'gemma4:26b-a4b-it-qat');
}

{
  // Старое хранилище: один общий слот на двоих. Провайдер openai — значит
  // model/apiKey в нём принадлежат ему.
  const { settings } = load({
    provider: 'openai',
    apiKey: 'ollama-ignores-this',
    model: 'gemma4:26b-a4b-it-qat',
    baseUrl: 'http://localhost:11434/v1',
  });
  const cfg = await settings();
  check('openai: старое хранилище читается', [cfg.model, cfg.apiKey], ['gemma4:26b-a4b-it-qat', 'ollama-ignores-this']);
}

{
  // Тот же общий слот, но в нём лежит ключ Anthropic: он попал туда из поля
  // Anthropic и уехать бэрером на чужой хост не должен.
  const { settings } = load({
    provider: 'openai',
    apiKey: 'sk-ant-real',
    model: 'gemma4:26b-a4b-it-qat',
    baseUrl: 'https://api.groq.com/openai/v1',
  });
  const cfg = await settings();
  check('openai: ключ sk-ant из общего слота не уезжает', [cfg.apiKey, cfg.model], ['', 'gemma4:26b-a4b-it-qat']);
}

{
  const { settings } = load({ provider: 'anthropic' });
  const cfg = await settings();
  check('anthropic: модель по умолчанию', cfg.model, 'claude-opus-5');
}

console.log('\n— проверка конфига перед запросом —');

{
  const { configError } = load({});
  const err = (cfg) => configError({ provider: 'anthropic', apiKey: '', model: '', baseUrl: '', ...cfg });

  check('anthropic без ключа — отказ', /Anthropic API key/.test(err({}) || ''), true);
  check('anthropic с ключом — ок', err({ apiKey: 'sk-ant' }), null);
  check(
    'openai без модели — отказ про модель, не про ключ Anthropic',
    /model/i.test(err({ provider: 'openai', baseUrl: 'http://localhost:11434/v1' }) || ''),
    true
  );
  check(
    'openai без ключа, но с моделью — ок',
    err({ provider: 'openai', model: 'gemma4:26b', baseUrl: 'http://localhost:11434/v1' }),
    null
  );
}

// ---- видимость полей в настройках ------------------------------------------

console.log('\n— поля настроек —');

/**
 * Крошечный матчер: только потомки и компаунды из #id/.class/тега — этого хватает
 * для селекторов panel.css.
 */
function matches(selector, path) {
  const parts = selector.trim().split(/\s+/);
  let i = path.length - 1;
  let j = parts.length - 1;
  if (!matchCompound(parts[j], path[i])) return false;
  i--; j--;
  while (j >= 0) {
    if (i < 0) return false;
    if (matchCompound(parts[j], path[i])) j--;
    i--;
  }
  return true;
}

function matchCompound(compound, el) {
  if (!el) return false;
  const tag = compound.match(/^[a-z]+/i);
  if (tag && tag[0] !== el.tag) return false;
  for (const id of compound.match(/#[\w-]+/g) || []) if (id.slice(1) !== el.id) return false;
  for (const cls of compound.match(/\.[\w-]+/g) || []) if (!el.classes.includes(cls.slice(1))) return false;
  // Псевдоклассы вроде :last-child этому тесту не нужны — они не про display.
  return !/:/.test(compound.replace(/:(hover|focus|last-child|first-child)\b/g, ''));
}

const css = fs.readFileSync(`${EXT}content/panel.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, sel, body]) => {
  const raw = (body.match(/display\s*:\s*([^;]+)/) || [])[1]?.trim();
  return {
    selectors: sel.split(',').map((s) => s.trim()).filter(Boolean),
    // `!important` (used by .tva-hidden so a later same-specificity rule with
    // its own `display` — e.g. .tva-list's `display: flex` — cannot win the
    // cascade) has to be stripped from the value here for the string compares
    // below, but its priority still has to be modeled separately — see
    // displayFor, which is otherwise a plain "last matching rule wins"
    // evaluator and would miss the exact bug this guards against.
    display: raw?.replace(/\s*!important$/, ''),
    important: /!important\s*$/.test(raw || ''),
  };
});

/** Группа чужого провайдера: <div class="tva-set-group tva-hidden" data-for="anthropic"> */
const hiddenField = [
  { tag: 'div', id: 'tva-root', classes: [] },
  { tag: 'div', id: 'tva-settings', classes: ['tva-settings'] },
  { tag: 'div', id: null, classes: ['tva-set-group', 'tva-hidden'] },
];
const visibleField = [
  hiddenField[0],
  hiddenField[1],
  { tag: 'div', id: null, classes: ['tva-set-group'] },
];

/**
 * The four elements panel.js itself toggles .tva-hidden on (showScreen()).
 * #tva-list is the one that actually broke: .tva-list's own `display: flex`
 * rule, declared later in the file at equal specificity, won the cascade over
 * .tva-hidden's `display: none` and left the message list visible behind the
 * settings screen. The other three passed only because no later rule happens
 * to set `display` on them — incidental, not structural — so they get the same
 * guard here.
 */
const hiddenList = [
  { tag: 'div', id: 'tva-root', classes: [] },
  { tag: 'div', id: null, classes: ['tva-body'] },
  { tag: 'div', id: 'tva-list', classes: ['tva-list', 'tva-hidden'] },
];
const hiddenEmpty = [
  hiddenList[0],
  hiddenList[1],
  { tag: 'div', id: 'tva-empty', classes: ['tva-empty', 'tva-hidden'] },
];
const hiddenSettings = [
  hiddenList[0],
  hiddenList[1],
  { tag: 'div', id: 'tva-settings', classes: ['tva-settings', 'tva-hidden'] },
];
const hiddenComposer = [
  hiddenList[0],
  { tag: 'footer', id: null, classes: ['tva-composer', 'tva-hidden'] },
];
/**
 * Пятый переключатель — popover контекста в композере. Ту же ловушку каскада
 * он поймал бы первым: у него нет своего display, так что закрытым он держится
 * только на .tva-hidden, а любое будущее правило с display на .tva-ctx-pop
 * (например display:grid для строк) объявлено позже и при равной
 * специфичности победило бы — popover остался бы висеть открытым.
 */
const hiddenCtxPop = [
  hiddenList[0],
  { tag: 'footer', id: null, classes: ['tva-composer'] },
  { tag: 'div', id: null, classes: ['tva-composer-chips'] },
  { tag: 'div', id: 'tva-ctx-pop', classes: ['tva-ctx-pop', 'tva-hidden'] },
];
const visibleCtxPop = [
  hiddenCtxPop[0],
  hiddenCtxPop[1],
  hiddenCtxPop[2],
  { tag: 'div', id: 'tva-ctx-pop', classes: ['tva-ctx-pop'] },
];

const displayFor = (path) => {
  let value = 'block';
  let importantWon = false;
  for (const rule of rules) {
    if (!rule.display) continue;
    if (!rule.selectors.some((s) => matches(s, path))) continue;
    // Once an !important declaration has matched, only a later !important
    // declaration can still override it — same tiering the real cascade uses,
    // and the reason .tva-hidden's `display: none !important` beats .tva-list's
    // later, merely-equal-specificity `display: flex`.
    if (importantWon && !rule.important) continue;
    value = rule.display;
    if (rule.important) importantWon = true;
  }
  return value;
};

check('поле с .tva-hidden скрыто', displayFor(hiddenField), 'none');
check('обычное поле видно', displayFor(visibleField) !== 'none', true);
check('скрытый список скрыт', displayFor(hiddenList), 'none');
check('скрытый empty state скрыт', displayFor(hiddenEmpty), 'none');
check('скрытый settings-экран скрыт', displayFor(hiddenSettings), 'none');
check('скрытый композер скрыт', displayFor(hiddenComposer), 'none');
check('закрытый popover контекста скрыт', displayFor(hiddenCtxPop), 'none');
check('открытый popover контекста виден', displayFor(visibleCtxPop) !== 'none', true);

console.log(failed ? `\n ПРОВАЛЕНО: ${failed}\n` : '\n всё зелёное\n');
process.exit(failed ? 1 : 0);
