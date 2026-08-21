/**
 * TVAgent — the conversation surface.
 *
 * Runs the real panel-chat.js under the shared fake DOM. What is expensive to
 * break here:
 *
 *   - escaping of everything that really arrives from the model: the tool
 *     name, its input, the text of an error, the result of a call. The fake
 *     parses innerHTML into a real tree, so a payload that "looks escaped"
 *     is not good enough — the test asks whether an <img onerror> came out as
 *     a live element or as dead text;
 *   - a run's calls collapsing into one "N actions" row rather than N raised
 *     boxes;
 *   - the streaming renderer, which is where the panel's cost per delta is.
 *     The whole message used to be re-rendered from innerHTML on every one of
 *     them; only the segment being written may change now, and the segments
 *     before it have to be closed nodes that are never touched again;
 *   - confirmation cards being settled when a run ends underneath one. The
 *     agent is awaiting that promise, so a card left unanswered parks a tool
 *     call for the life of the page;
 *   - the list not growing without bound.
 *
 *   node chat-test.mjs
 */
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

// -------------------------------------------------------------- esc()

section('esc()');

{
  const { Chat } = fresh();
  check('esc: &', Chat.esc('&'), '&amp;');
  check('esc: <', Chat.esc('<'), '&lt;');
  check('esc: >', Chat.esc('>'), '&gt;');
  check('esc: "', Chat.esc('"'), '&quot;');
  check("esc: '", Chat.esc("'"), '&#39;');
  check('esc: all five at once', Chat.esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  check('esc: ordinary text is left alone', Chat.esc('EMA 50/200'), 'EMA 50/200');
}

// ------------------------------------------------------- streamed text

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
  // The fence itself split across two deltas, which is what a real stream
  // does — the renderer holds back a partial run of backticks rather than
  // printing it and then discovering the rest.
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
 * The split that actually happens, and the one the holdback used to break.
 *
 * "```" is a single token, so the fence usually arrives as its own delta
 * rather than straddling two. Holding back a trailing run of backticks before
 * looking for a fence took two of those three, left the third as text, and put
 * the seam somewhere nothing looked again: the block never opened and the
 * answer rendered with its backticks showing. Every way of cutting the same
 * text has to come out the same.
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
  // One backtick per delta — the worst cut there is, and the fence still has
  // to be recognised across five of them.
  const { listEl, chat } = fresh();
  chat.startRun();
  stream(chat, 'a\n```\nb\n```\nc', 1);
  chat.endRun();
  const pre = findTag(listEl, 'PRE');
  check('character by character: the block opened', !!pre, true);
  check('character by character: its body is the code', pre && pre.textContent, 'b\n');
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
  // The point of the incremental renderer: a segment that is already closed
  // is never rewritten. A run of deltas has to leave the earlier nodes as
  // they were, identity and all.
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
  const { listEl, chat } = fresh();
  chat.startRun();
  chat.onToolStart({ id: 'known', name: 'get_chart', input: {} });

  let threw = false;
  try {
    chat.onToolResult({ id: 'unknown-id', ok: true, result: 'z' });
  } catch (e) {
    threw = true;
  }
  check('a result for an unknown id is a no-op, not a throw', threw, false);
  check('and the real call is untouched', listEl.querySelector('.tva-call-status').textContent, 'running…');
}

{
  // The result arrives from the model exactly as the name and input do, and
  // it goes in through textContent += rather than innerHTML. This is the one
  // place where swapping the two would look like tidying up and would be a
  // live XSS: the fake's textContent setter takes the string literally, while
  // its innerHTML setter really parses tags into nodes.
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
  // get_series_data comes back with ~300 bars. Nobody reads that in a folded
  // trace row, and the panel pays for every character of it on every scroll.
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
  // The commonest run of all: a plain text answer with no tool call. runEl is
  // never created (only onThinking and onToolStart create it), and endRun()
  // has to survive that without reaching into null.
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
  // Deliberately no endRun(): clear() has to reset runEl itself rather than
  // rely on endRun having done it. That is the case that matters — New chat
  // clicked while the agent is mid-run.
  const { listEl, chat } = fresh();
  chat.startRun();
  chat.onToolStart({ id: 'a', name: 'first', input: {} });
  chat.clear();
  check('clear() empties the list even mid-run', listEl.children.length, 0);

  // The real danger is not the empty list but a forgotten reference to the
  // old, now-detached run row: the next onToolStart would decide a run
  // already exists, write into a detached subtree, and add nothing visible.
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
  // Stop, or New chat, while a card is on screen. The agent is awaiting this
  // promise inside its tool loop: an unanswered card parks that call forever
  // and the panel keeps its Stop button over an agent that has finished.
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
