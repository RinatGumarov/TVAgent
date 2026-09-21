/** Runs the real panel-chat.js under the fake DOM. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument, click, findTag, findDangerousTag, descendants } from './helpers/dom.mjs';
import { loadModule } from './helpers/load.mjs';

function load(doc) {
  const win = {};
  return loadModule('content/panel-chat.js', { window: win, document: doc });
}

function fresh() {
  const doc = makeDocument();
  const Chat = load(doc);
  const listEl = doc.createElement('div');
  return { Chat, listEl, chat: Chat.create(listEl) };
}

/** The rendered text of the assistant message, as a reader would see it. */
const assistantText = (listEl) =>
  listEl
    .querySelectorAll('.tva-msg')
    .filter((n) => n.className.includes('assistant'))
    .map((n) => n.textContent)
    .join('');

describe('streaming text', async () => {
  /** Feeds one string through onText in chunks of `size`, as a stream would. */
  function stream(chat, text, size) {
    for (let i = 0; i < text.length; i += size) chat.onText(text.slice(i, i + size));
  }

  {
    const { listEl, chat } = fresh();
    chat.startRun();
    stream(chat, 'Added EMA 50 and EMA 200 to the chart.', 3);
    chat.endRun();
    const got1 = assistantText(listEl);
    const want1 = 'Added EMA 50 and EMA 200 to the chart.';
    it('plain prose arrives whole', () => {
      assert.deepStrictEqual(got1, want1);
    });
  }

  {
    const { listEl, chat } = fresh();
    chat.startRun();
    stream(chat, 'Here is the script:\n```js\nstrategy("x")\n```\nDone.', 4);
    chat.endRun();

    const pre = findTag(listEl, 'PRE');
    const got2 = !!pre;
    const want2 = true;
    it('the fenced block became a <pre>', () => {
      assert.deepStrictEqual(got2, want2);
    });
    const got3 = pre.textContent;
    const want3 = 'strategy("x")\n';
    it('with the language tag stripped and the body intact', () => {
      assert.deepStrictEqual(got3, want3);
    });
    const got4 = assistantText(listEl).includes('Here is the script:');
    const want4 = true;
    it('and the prose around it survived', () => {
      assert.deepStrictEqual(got4, want4);
    });
    const got5 = assistantText(listEl).includes('Done.');
    const want5 = true;
    it('including what came after the fence', () => {
      assert.deepStrictEqual(got5, want5);
    });
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
    const got6 = !!pre;
    const want6 = true;
    it('a fence split across deltas is still a fence', () => {
      assert.deepStrictEqual(got6, want6);
    });
    const got7 = pre.textContent;
    const want7 = 'code\n';
    it('its body is the code', () => {
      assert.deepStrictEqual(got7, want7);
    });
    const got8 = assistantText(listEl).includes('``');
    const want8 = false;
    it('and no stray backticks leaked into the prose', () => {
      assert.deepStrictEqual(got8, want8);
    });
  }

  /**
   * Every way of cutting the same text has to come out the same: "```" is one
   * token and usually arrives as its own delta.
   */
  {
    const cuts = {
      whole: ['Here is the script:\n```js\nstrategy("x")\n```\nDone.'],
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
      const got9 = !!pre;
      const want9 = true;
      it(`${how}: the block opened`, () => {
        assert.deepStrictEqual(got9, want9);
      });
      const got10 = pre && pre.textContent;
      const want10 = 'strategy("x")\n';
      it(`${how}: its body is the code`, () => {
        assert.deepStrictEqual(got10, want10);
      });
      const got11 = assistantText(listEl).includes('``');
      const want11 = false;
      it(`${how}: no backticks leaked into the prose`, () => {
        assert.deepStrictEqual(got11, want11);
      });
    }
  }

  {
    const { listEl, chat } = fresh();
    chat.startRun();
    stream(chat, 'markup <script>alert(1)</script> and <img src=x>', 5);
    chat.endRun();
    const got12 = findDangerousTag(listEl);
    const want12 = null;
    it('streamed markup produced no live element', () => {
      assert.deepStrictEqual(got12, want12);
    });
    const got13 = assistantText(listEl);
    const want13 = 'markup <script>alert(1)</script> and <img src=x>';
    it('and reads back as the text it was', () => {
      assert.deepStrictEqual(got13, want13);
    });
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
    const got14 = [after[0] === closed[0], after[1] === closed[1]];
    const want14 = [true, true];
    it('the nodes before the tail are the same objects', () => {
      assert.deepStrictEqual(got14, want14);
    });
    chat.endRun();
  }

  {
    const { listEl, chat } = fresh();
    chat.startRun();
    chat.onText('first message');
    chat.onBlockStart('text');
    chat.onText('second message');
    chat.endRun();
    const got15 = listEl.querySelectorAll('.tva-msg').length;
    const want15 = 2;
    it('a new text block starts a new message row', () => {
      assert.deepStrictEqual(got15, want15);
    });
  }

  // -------------------------------------------------- escaping into the DOM
});

describe('what really arrives from the model does not reach the DOM as tags', async () => {
  {
    const { listEl, chat } = fresh();

    const evilName = '<img src=x onerror=alert(1)>';
    const evilInput = { note: 'she said "hi" <script>alert(1)</script>' };
    chat.onToolStart({ id: 't1', name: evilName, input: evilInput });

    const got16 = findDangerousTag(listEl);
    const want16 = null;
    it('a hostile tool name produced no <img>/<script> node', () => {
      assert.deepStrictEqual(got16, want16);
    });
    const got17 = listEl.querySelector('.tva-call-name').textContent;
    const want17 = evilName;
    it('the name reads back as the text it was', () => {
      assert.deepStrictEqual(got17, want17);
    });
    const got18 = listEl.querySelector('.tva-call-body').textContent;
    const want18 = JSON.stringify(evilInput, null, 2);
    it('an input with a quote and a <script> stayed text inside the <pre>', () => {
      assert.deepStrictEqual(got18, want18);
    });
  }

  {
    const { listEl, chat } = fresh();

    const evilError = '<b>bold</b> & "quoted" <iframe src=evil>';
    const el = chat.error(evilError);

    const got19 = findDangerousTag(listEl);
    const want19 = null;
    it('an error carrying markup produced no tag at all', () => {
      assert.deepStrictEqual(got19, want19);
    });
    const got20 = findTag(listEl, 'b');
    const want20 = null;
    it('nor a <b> — a tag from another template in this module', () => {
      assert.deepStrictEqual(got20, want20);
    });
    const got21 = el.children.every((c) => c.nodeType === 'text');
    const want21 = true;
    it('the node holds text and nothing else', () => {
      assert.deepStrictEqual(got21, want21);
    });
    const got22 = el.textContent;
    const want22 = evilError;
    it('and the error reads back as written', () => {
      assert.deepStrictEqual(got22, want22);
    });
  }

  // ------------------------------------------------------ run collapsing
});

describe('tool calls are always on screen', () => {
  it('every call is its own top-level row, in order, with its name showing', () => {
    const { listEl, chat } = fresh();
    chat.startRun();
    chat.onToolStart({ id: 'a', name: 'get_chart', input: {} });
    chat.onText('Switching symbol.');
    chat.onToolStart({ id: 'b', name: 'set_symbol', input: { symbol: 'BTCUSD' } });

    assert.deepStrictEqual(
      listEl.children.map((row) => row.className),
      ['tva-call', 'tva-msg assistant', 'tva-call'],
    );
    assert.deepStrictEqual(
      listEl.querySelectorAll('.tva-call-name').map((n) => n.textContent),
      ['get_chart', 'set_symbol'],
    );
  });

  it('the input stays folded under the row', () => {
    const { listEl, chat } = fresh();
    chat.startRun();
    chat.onToolStart({ id: 'a', name: 'set_symbol', input: { symbol: 'BTCUSD' } });
    const call = listEl.querySelector('.tva-call');
    assert.deepStrictEqual(call.tagName, 'DETAILS');
    assert.deepStrictEqual(call.open, false);
    assert.match(call.querySelector('.tva-call-body').textContent, /BTCUSD/);
  });

  it('reasoning is a folded row of its own, and a tool call ends it', () => {
    const { listEl, chat } = fresh();
    chat.startRun();
    chat.onThinking('first ');
    chat.onThinking('thought');
    chat.onToolStart({ id: 'a', name: 'get_chart', input: {} });
    chat.onThinking('second thought');

    assert.deepStrictEqual(
      listEl.children.map((row) => row.className),
      ['tva-think', 'tva-call', 'tva-think'],
    );
    assert.deepStrictEqual(listEl.children[0].open, false);
    assert.deepStrictEqual(
      listEl.querySelectorAll('.tva-think-body').map((n) => n.textContent),
      ['first thought', 'second thought'],
    );
  });
});

describe('onToolResult', async () => {
  {
    const { listEl, chat } = fresh();
    chat.startRun();
    chat.onToolStart({ id: 'f', name: 'set_pine_code', input: {} });
    chat.onToolResult({ id: 'f', ok: false, result: 'boom' });

    const got27 = listEl.querySelector('.tva-call').open;
    const want27 = true;
    it('a failure unfolds the call', () => {
      assert.deepStrictEqual(got27, want27);
    });
    const got28 = listEl.querySelector('.tva-call-status').textContent;
    const want28 = 'failed';
    it('and the call is marked failed', () => {
      assert.deepStrictEqual(got28, want28);
    });
  }

  {
    const { listEl, chat } = fresh();
    chat.startRun();
    chat.onToolStart({ id: 's', name: 'get_chart', input: {} });
    chat.onToolResult({ id: 's', ok: true, result: 'fine' });

    const got29 = listEl.querySelector('.tva-call').open;
    const want29 = false;
    it('a success leaves it folded', () => {
      assert.deepStrictEqual(got29, want29);
    });
    const got30 = listEl.querySelector('.tva-call-status').textContent;
    const want30 = 'done';
    it('and the call is marked done', () => {
      assert.deepStrictEqual(got30, want30);
    });
  }

  {
    // The result is model-controlled text and goes in through textContent, not
    // innerHTML.
    const { listEl, chat } = fresh();
    chat.startRun();
    chat.onToolStart({ id: 'r', name: 'get_chart', input: {} });
    const evilResult = '<img src=x onerror=alert(1)>';
    chat.onToolResult({ id: 'r', ok: true, result: evilResult });

    const got31 = findDangerousTag(listEl);
    const want31 = null;
    it('a result carrying markup produced no <img> node', () => {
      assert.deepStrictEqual(got31, want31);
    });
    const got32 = listEl.querySelector('.tva-call-body').textContent.includes(evilResult);
    const want32 = true;
    it('the call body holds the result as literal text', () => {
      assert.deepStrictEqual(got32, want32);
    });
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
    const got33 = body.length < 5000;
    const want33 = true;
    it('a huge result is clipped', () => {
      assert.deepStrictEqual(got33, want33);
    });
    const got34 = /more characters/.test(body);
    const want34 = true;
    it('and says how much was left out', () => {
      assert.deepStrictEqual(got34, want34);
    });
  }

  // ----------------------------------------------------------------- lifecycle
});

describe('lifecycle: startRun / endRun / clear', () => {
  it('endRun() on a run with no tool call leaves only the answer', () => {
    const { listEl, chat } = fresh();
    chat.startRun();
    chat.onText('hi');
    chat.endRun();
    assert.deepStrictEqual(
      listEl.children.map((row) => row.className),
      ['tva-msg assistant'],
    );
  });

  it('a result that arrives after clear() is dropped, and new calls still land', () => {
    // New chat mid-run: the old call's row is gone.
    const { listEl, chat } = fresh();
    chat.startRun();
    chat.onToolStart({ id: 'a', name: 'first', input: {} });
    chat.clear();
    assert.deepStrictEqual(listEl.children.length, 0);

    chat.onToolResult({ id: 'a', ok: true, result: 'late' });
    chat.onToolStart({ id: 'c', name: 'third', input: {} });
    assert.deepStrictEqual(
      listEl.querySelectorAll('.tva-call-name').map((n) => n.textContent),
      ['third'],
    );
  });
});

describe('onConfirm', async () => {
  {
    const { listEl, chat } = fresh();

    const promise = chat.onConfirm({ name: 'set_pine_code', input: { code: 'strategy()' } });
    const confirmEl = listEl.querySelector('.tva-confirm-head').parent;

    const got43 = confirmEl.querySelector('.tva-confirm-actions') !== null;
    const want43 = true;
    it('the buttons are there until it is answered', () => {
      assert.deepStrictEqual(got43, want43);
    });
    click(confirmEl.querySelector('[data-yes]'));

    const got44 = await promise;
    const want44 = true;
    it('Allow resolves the promise true', () => {
      assert.deepStrictEqual(got44, want44);
    });
    const got45 = confirmEl.querySelector('.tva-confirm-actions');
    const want45 = null;
    it('the buttons are gone afterwards', () => {
      assert.deepStrictEqual(got45, want45);
    });
    const got46 = confirmEl.querySelector('.tva-confirm-outcome').textContent;
    const want46 = 'Allowed';
    it('and the outcome is written', () => {
      assert.deepStrictEqual(got46, want46);
    });
  }

  {
    const { listEl, chat } = fresh();

    const promise = chat.onConfirm({ name: 'set_pine_code', input: { code: 'strategy()' } });
    const confirmEl = listEl.querySelector('.tva-confirm-head').parent;
    click(confirmEl.querySelector('[data-no]'));

    const got47 = await promise;
    const want47 = false;
    it('Deny resolves the promise false', () => {
      assert.deepStrictEqual(got47, want47);
    });
    const got48 = confirmEl.querySelector('.tva-confirm-actions');
    const want48 = null;
    it('the buttons are gone afterwards', () => {
      assert.deepStrictEqual(got48, want48);
    });
    const got49 = confirmEl.querySelector('.tva-confirm-outcome').textContent;
    const want49 = 'Denied';
    it('and the outcome is written', () => {
      assert.deepStrictEqual(got49, want49);
    });
  }

  {
    // Stop, or New chat, while a card is on screen: the agent is awaiting this
    // promise.
    const { listEl, chat } = fresh();
    chat.startRun();
    const promise = chat.onConfirm({ name: 'set_pine_code', input: { code: 'strategy()' } });
    chat.endRun();

    const got50 = await promise;
    const want50 = false;
    it('ending the run answers the card', () => {
      assert.deepStrictEqual(got50, want50);
    });
    const confirmEl = listEl.querySelector('.tva-confirm-head').parent;
    const got51 = confirmEl.querySelector('.tva-confirm-outcome').textContent;
    const want51 = 'Stopped';
    it('and says so on the card', () => {
      assert.deepStrictEqual(got51, want51);
    });
    const got52 = confirmEl.querySelector('.tva-confirm-actions');
    const want52 = null;
    it('the buttons are gone', () => {
      assert.deepStrictEqual(got52, want52);
    });
  }

  {
    const { chat } = fresh();
    chat.startRun();
    const promise = chat.onConfirm({ name: 'set_pine_code', input: {} });
    chat.clear();
    const got53 = await promise;
    const want53 = false;
    it('clear() answers it too', () => {
      assert.deepStrictEqual(got53, want53);
    });
  }

  // ------------------------------------------------------------ list growth
});

describe('the list does not grow without bound', async () => {
  {
    const { listEl, chat } = fresh();
    for (let i = 0; i < 500; i++) chat.user(`message ${i}`);

    const got54 = listEl.children.length <= 301;
    const want54 = true;
    it('the row count is capped', () => {
      assert.deepStrictEqual(got54, want54);
    });
    const got55 = descendants(listEl).some(
      (n) => n.nodeType === 'text' && n.text === 'message 499',
    );
    const want55 = true;
    it('the newest message is still there', () => {
      assert.deepStrictEqual(got55, want55);
    });
    const got56 = descendants(listEl).some((n) => n.nodeType === 'text' && n.text === 'message 0');
    const want56 = false;
    it('the oldest is gone', () => {
      assert.deepStrictEqual(got56, want56);
    });
    const got57 = listEl.querySelectorAll('.tva-trimmed').length;
    const want57 = 1;
    it('and the trim is announced rather than silent', () => {
      assert.deepStrictEqual(got57, want57);
    });
  }
});
