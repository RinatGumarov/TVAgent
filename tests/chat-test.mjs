/** Runs the real panel-chat.js under the fake DOM. */
import { check, section, report } from './helpers/check.mjs';
import { makeDocument, click, findTag, findDangerousTag, descendants } from './helpers/dom.mjs';
import { readSource } from './helpers/load.mjs';

const src = readSource('content/panel-chat.js');

function load(doc) {
  const win = {};
  new Function('window', 'document', src)(win, doc);
  return win.TVAgentChat;
}

function fresh() {
  const doc = makeDocument();
  const Chat = load(doc);
  const listEl = doc.createElement('div');
  return { Chat, listEl, chat: Chat.create(listEl) };
}

/** The rendered text of the assistant message, as a reader would see it. */
const assistantText = (listEl) =>
  listEl.querySelectorAll('.tva-msg').filter((n) => n.className.includes('assistant')).map((n) => n.textContent).join('');

section('streaming text');

/** Feeds one string through onText in chunks of `size`, as a stream would. */
function stream(chat, text, size) {
  for (let i = 0; i < text.length; i += size) chat.onText(text.slice(i, i + size));
}

{
  const { listEl, chat } = fresh();
  chat.startRun();
  stream(chat, 'Added EMA 50 and EMA 200 to the chart.', 3);
  chat.endRun();
  check('plain prose arrives whole', assistantText(listEl), 'Added EMA 50 and EMA 200 to the chart.');
}

{
  const { listEl, chat } = fresh();
  chat.startRun();
  stream(chat, 'Here is the script:\n```js\nstrategy("x")\n```\nDone.', 4);
  chat.endRun();

  const pre = findTag(listEl, 'PRE');
  check('the fenced block became a <pre>', !!pre, true);
  check('with the language tag stripped and the body intact', pre.textContent, 'strategy("x")\n');
  check('and the prose around it survived', assistantText(listEl).includes('Here is the script:'), true);
  check('including what came after the fence', assistantText(listEl).includes('Done.'), true);
}

{
  // The fence split across two deltas, as a real stream does.
  const { listEl, chat } = fresh();
  chat.startRun();
  chat.onText('before ``');
  chat.onText('`\ncode\n``');
  chat.onText('`\nafter');
  chat.endRun();

  const pre = findTag(listEl, 'PRE');
  check('a fence split across deltas is still a fence', !!pre, true);
  check('its body is the code', pre.textContent, 'code\n');
  check('and no stray backticks leaked into the prose', assistantText(listEl).includes('``'), false);
}

/**
 * Every way of cutting the same text has to come out the same: "```" is one
 * token and usually arrives as its own delta.
 */
{
  const cuts = {
    'whole': ['Here is the script:\n```js\nstrategy("x")\n```\nDone.'],
    'fence alone': ['Here is the script:\n', '```', 'js\nstrategy("x")\n', '```', '\nDone.'],
    'fence 1+2': ['Here is the script:\n`', '``js\nstrategy("x")\n`', '``\nDone.'],
    'fence 2+1': ['Here is the script:\n``', '`js\nstrategy("x")\n``', '`\nDone.'],
  };
  for (const [how, deltas] of Object.entries(cuts)) {
    const { listEl, chat } = fresh();
    chat.startRun();
    deltas.forEach((d) => chat.onText(d));
    chat.endRun();
    const pre = findTag(listEl, 'PRE');
    check(`${how}: the block opened`, !!pre, true);
    check(`${how}: its body is the code`, pre && pre.textContent, 'strategy("x")\n');
    check(`${how}: no backticks leaked into the prose`, assistantText(listEl).includes('``'), false);
  }
}

{
  const { listEl, chat } = fresh();
  chat.startRun();
  stream(chat, 'markup <script>alert(1)</script> and <img src=x>', 5);
  chat.endRun();
  check('streamed markup produced no live element', findDangerousTag(listEl), null);
  check('and reads back as the text it was', assistantText(listEl), 'markup <script>alert(1)</script> and <img src=x>');
}

{
  // A segment that is already closed is never rewritten: the earlier nodes
  // keep their identity.
  const { listEl, chat } = fresh();
  chat.startRun();
  chat.onText('one\n```\ncode\n```\n');
  const closed = listEl.querySelectorAll('.tva-msg')[0].children.slice(0, 2);
  chat.onText('a lot more prose after the block');
  chat.onText(' and more still');
  const after = listEl.querySelectorAll('.tva-msg')[0].children.slice(0, 2);
  check('the nodes before the tail are the same objects', [after[0] === closed[0], after[1] === closed[1]], [true, true]);
  chat.endRun();
}

{
  const { listEl, chat } = fresh();
  chat.startRun();
  chat.onText('first message');
  chat.onBlockStart('text');
  chat.onText('second message');
  chat.endRun();
  check('a new text block starts a new message row', listEl.querySelectorAll('.tva-msg').length, 2);
}

// -------------------------------------------------- escaping into the DOM

section('what really arrives from the model does not reach the DOM as tags');

{
  const { listEl, chat } = fresh();

  const evilName = '<img src=x onerror=alert(1)>';
  const evilInput = { note: 'she said "hi" <script>alert(1)</script>' };
  chat.onToolStart({ id: 't1', name: evilName, input: evilInput });

  check('a hostile tool name produced no <img>/<script> node', findDangerousTag(listEl), null);
  check(
    'the name reads back as the text it was',
    listEl.querySelector('.tva-call-name').textContent,
    evilName
  );
  check(
    'an input with a quote and a <script> stayed text inside the <pre>',
    listEl.querySelector('.tva-call-body').textContent,
    JSON.stringify(evilInput, null, 2)
  );
}

{
  const { listEl, chat } = fresh();

  const evilError = '<b>bold</b> & "quoted" <iframe src=evil>';
  const el = chat.error(evilError);

  check('an error carrying markup produced no tag at all', findDangerousTag(listEl), null);
  check('nor a <b> — a tag from another template in this module', findTag(listEl, 'b'), null);
  check('the node holds text and nothing else', el.children.every((c) => c.nodeType === 'text'), true);
  check('and the error reads back as written', el.textContent, evilError);
}

// ------------------------------------------------------ run collapsing

section('one run row for N calls, not N boxes');

{
  const { listEl, chat } = fresh();
  chat.startRun();
  chat.onToolStart({ id: 'a', name: 'get_chart', input: {} });
  chat.onToolStart({ id: 'b', name: 'set_symbol', input: { symbol: 'BTCUSD' } });
  chat.onToolStart({ id: 'c', name: 'add_indicator', input: { name: 'EMA' } });

  check('three onToolStart, one .tva-run row', listEl.querySelectorAll('.tva-run').length, 1);
  check('with three .tva-call inside it', listEl.querySelectorAll('.tva-call').length, 3);
  check('labelled "3 actions"', listEl.querySelector('.tva-run-label').textContent, '3 actions');
}

{
  const { listEl, chat } = fresh();
  chat.startRun();
  chat.onToolStart({ id: 'a', name: 'get_chart', input: {} });
  check('one call is "1 action", singular', listEl.querySelector('.tva-run-label').textContent, '1 action');
}

// -------------------------------------------------------------- onToolResult

section('onToolResult');

{
  const { listEl, chat } = fresh();
  chat.startRun();
  chat.onToolStart({ id: 'f', name: 'set_pine_code', input: {} });
  chat.onToolResult({ id: 'f', ok: false, result: 'boom' });

  check('a failure unfolds the run row', listEl.querySelector('.tva-run').open, true);
  check('and the call is marked failed', listEl.querySelector('.tva-call-status').textContent, 'failed');
}

{
  const { listEl, chat } = fresh();
  chat.startRun();
  chat.onToolStart({ id: 's', name: 'get_chart', input: {} });
  chat.onToolResult({ id: 's', ok: true, result: 'fine' });

  check('a success leaves it folded', listEl.querySelector('.tva-run').open, false);
  check('and the call is marked done', listEl.querySelector('.tva-call-status').textContent, 'done');
}

{
  // The result is model-controlled text and goes in through textContent, not
  // innerHTML.
  const { listEl, chat } = fresh();
  chat.startRun();
  chat.onToolStart({ id: 'r', name: 'get_chart', input: {} });
  const evilResult = '<img src=x onerror=alert(1)>';
  chat.onToolResult({ id: 'r', ok: true, result: evilResult });

  check('a result carrying markup produced no <img> node', findDangerousTag(listEl), null);
  check(
    'the call body holds the result as literal text',
    listEl.querySelector('.tva-call-body').textContent.includes(evilResult),
    true
  );
}

{
  // get_series_data comes back with ~300 bars; nobody reads that in a folded
  // row.
  const { listEl, chat } = fresh();
  chat.startRun();
  chat.onToolStart({ id: 'big', name: 'get_series_data', input: {} });
  const huge = 'x'.repeat(50000);
  chat.onToolResult({ id: 'big', ok: true, result: huge });

  const body = listEl.querySelector('.tva-call-body').textContent;
  check('a huge result is clipped', body.length < 5000, true);
  check('and says how much was left out', /more characters/.test(body), true);
}

// ----------------------------------------------------------------- lifecycle

section('lifecycle: startRun / endRun / clear');

{
  const { listEl, chat } = fresh();

  chat.startRun();
  chat.onToolStart({ id: 'a', name: 'first', input: {} });
  chat.endRun();

  chat.startRun();
  chat.onToolStart({ id: 'b', name: 'second', input: {} });
  chat.endRun();

  check('two runs are two separate rows', listEl.querySelectorAll('.tva-run').length, 2);
  const labels = listEl.querySelectorAll('.tva-run-label').map((n) => n.textContent);
  check('each counts its own actions, with nothing carried over', labels, ['1 action', '1 action']);
  const marks = listEl.querySelectorAll('.tva-run-mark');
  check('both are marked done', marks.every((m) => m.classList.contains('done')), true);
}

{
  // A plain text answer with no tool call: runEl is never created, and
  // endRun() has to survive that.
  const { listEl, chat } = fresh();
  chat.startRun();
  chat.onText('hi');
  let threw = false;
  try {
    chat.endRun();
  } catch (e) {
    threw = true;
  }
  check('endRun() on a run with no tool call does not throw', threw, false);
  check('and does not leave an empty .tva-run row', listEl.querySelectorAll('.tva-run').length, 0);
}

{
  // No endRun(): clear() has to reset runEl itself, as New chat mid-run does.
  const { listEl, chat } = fresh();
  chat.startRun();
  chat.onToolStart({ id: 'a', name: 'first', input: {} });
  chat.clear();
  check('clear() empties the list even mid-run', listEl.children.length, 0);

  chat.onToolStart({ id: 'c', name: 'third', input: {} });
  check('a call after clear() opens a fresh run rather than going nowhere', listEl.querySelectorAll('.tva-run').length, 1);
  check('with exactly one action in it', listEl.querySelector('.tva-run-label').textContent, '1 action');
}

// -------------------------------------------------------------- onConfirm

section('onConfirm');

{
  const { listEl, chat } = fresh();

  const promise = chat.onConfirm({ name: 'set_pine_code', input: { code: 'strategy()' } });
  const confirmEl = listEl.querySelector('.tva-confirm-head').parent;

  check('the buttons are there until it is answered', confirmEl.querySelector('.tva-confirm-actions') !== null, true);
  click(confirmEl.querySelector('[data-yes]'));

  check('Allow resolves the promise true', await promise, true);
  check('the buttons are gone afterwards', confirmEl.querySelector('.tva-confirm-actions'), null);
  check('and the outcome is written', confirmEl.querySelector('.tva-confirm-outcome').textContent, 'Allowed');
}

{
  const { listEl, chat } = fresh();

  const promise = chat.onConfirm({ name: 'set_pine_code', input: { code: 'strategy()' } });
  const confirmEl = listEl.querySelector('.tva-confirm-head').parent;
  click(confirmEl.querySelector('[data-no]'));

  check('Deny resolves the promise false', await promise, false);
  check('the buttons are gone afterwards', confirmEl.querySelector('.tva-confirm-actions'), null);
  check('and the outcome is written', confirmEl.querySelector('.tva-confirm-outcome').textContent, 'Denied');
}

{
  // Stop, or New chat, while a card is on screen: the agent is awaiting this
  // promise.
  const { listEl, chat } = fresh();
  chat.startRun();
  const promise = chat.onConfirm({ name: 'set_pine_code', input: { code: 'strategy()' } });
  chat.endRun();

  check('ending the run answers the card', await promise, false);
  const confirmEl = listEl.querySelector('.tva-confirm-head').parent;
  check('and says so on the card', confirmEl.querySelector('.tva-confirm-outcome').textContent, 'Stopped');
  check('the buttons are gone', confirmEl.querySelector('.tva-confirm-actions'), null);
}

{
  const { chat } = fresh();
  chat.startRun();
  const promise = chat.onConfirm({ name: 'set_pine_code', input: {} });
  chat.clear();
  check('clear() answers it too', await promise, false);
}

// ------------------------------------------------------------ list growth

section('the list does not grow without bound');

{
  const { listEl, chat } = fresh();
  for (let i = 0; i < 500; i++) chat.user(`message ${i}`);

  check('the row count is capped', listEl.children.length <= 301, true);
  check('the newest message is still there', descendants(listEl).some((n) => n.nodeType === 'text' && n.text === 'message 499'), true);
  check('the oldest is gone', descendants(listEl).some((n) => n.nodeType === 'text' && n.text === 'message 0'), false);
  check('and the trim is announced rather than silent', listEl.querySelectorAll('.tva-trimmed').length, 1);
}

report();
