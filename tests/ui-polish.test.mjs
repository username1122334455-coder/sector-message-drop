import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import postcss from 'postcss';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const css = postcss.parse(html.match(/<style>([\s\S]*?)<\/style>/)[1]);
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const declarations = (selector) => {
  const result = {};
  css.walkRules(selector, (rule) => rule.walkDecls((decl) => { result[decl.prop] = decl.value; }));
  return result;
};

test('local clock is unambiguous at midnight, noon and evening', () => {
  const body = script.match(/const updateMilitaryClock = \(\) => \{([\s\S]*?)\n      \};/)[1];
  for (const [hours, minutes, expected] of [[0, 5, '00:05'], [12, 30, '12:30'], [20, 9, '20:09']]) {
    const clock = {};
    class LocalDate {
      getHours() { return hours; }
      getMinutes() { return minutes; }
      toISOString() { return '2026-10-08T02:09:00.000Z'; }
    }
    runInNewContext(body, { Date: LocalDate, militaryClock: clock });
    assert.equal(clock.textContent, expected);
    assert.equal(clock.dateTime, '2026-10-08T02:09:00.000Z');
  }
});

test('online count is driven by presence rather than an hourly forced zero', () => {
  assert.ok(!/setInterval\([^;]*updateOnlineUsers\(0\)/.test(script));
  assert.ok(/presenceState\(\)/.test(script));
  assert.ok(/updateOnlineUsers\(count\)/.test(script));
});

test('completed reply animation clears its hidden row and accessibility state', () => {
  const code = script.match(/missionAlert\.addEventListener\("animationend", \(event\) => \{[\s\S]*?\n      \}\);/)[0];
  const classes = new Set(['is-visible']);
  const attributes = new Map([['aria-hidden', 'false']]);
  let handler;
  runInNewContext(code, { missionAlert: {
    addEventListener: (name, listener) => { assert.equal(name, 'animationend'); handler = listener; },
    classList: { remove: name => classes.delete(name) },
    setAttribute: (name, value) => attributes.set(name, value),
  } });
  handler({ animationName: 'unrelated' });
  assert.equal(attributes.get('aria-hidden'), 'false');
  handler({ animationName: 'alertPop' });
  assert.equal(attributes.get('aria-hidden'), 'true');
  assert.equal(classes.has('is-visible'), false);
});

test('long messages can scroll and retain typed case; decorative caret yields to input', () => {
  assert.equal(declarations('#messageInput')['overflow-y'], 'auto');
  assert.equal(declarations('#messageInput')['text-transform'], 'none');
  assert.equal(declarations('.panel.is-active .typing-caret').display, 'none');
  assert.match(html, /maxlength="500"/);
});

test('mobile send control keeps a 54px touch target instead of stretching to 112px', () => {
  const rule = css.nodes.filter((node) => node.type === 'atrule' && node.params === '(max-width: 520px)')
    .flatMap((node) => node.nodes).find((node) => node.selector === '#sendButton');
  assert.ok(rule);
  const values = Object.fromEntries(rule.nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]));
  assert.equal(values.flex, '0 0 54px');
  assert.equal(values.height, '54px');
});

test('keyboard focus is visible and narrow verification can scroll without removing protection', () => {
  assert.equal(declarations('button:focus-visible,\n      a:focus-visible,\n      input:focus-visible,\n      textarea:focus-visible').outline, '3px solid #173d43');
  assert.equal(declarations('.verification-gate')['overflow-y'], 'auto');
  assert.equal(declarations('.turnstile-widget')['overflow-x'], 'auto');
  assert.match(script, /const BOT_VERIFICATION_ENABLED = true;/);
});
