import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const current = await readFile(new URL('index.html', root), 'utf8');
const original = execFileSync('git', ['show', '2b67df51c0b82e06a8f99a02f7b54590f35f0a75:index.html'],
  { cwd: root, maxBuffer: 2 * 1024 * 1024 }).toString();
const section = (html, pattern) => {
  const match = html.match(pattern);
  assert.ok(match, 'expected page section missing');
  return match[0];
};

test('polish preserves the original stylesheet under one explicit additive region', () => {
  const style = section(current, /<style>[\s\S]*?<\/style>/);
  const patches = [...style.matchAll(/      \/\* REFINED_UI_START: additive polish; original theme rules retained\. \*\/[\s\S]*?      \/\* REFINED_UI_END \*\/\n/g)];
  assert.equal(patches.length, 1);
  assert.ok(style.replace(patches[0][0], '') === section(original, /<style>[\s\S]*?<\/style>/),
    'original theme rules changed outside the reviewed additive polish');
});

test('application differs only by reviewed clock, presence and alert cleanup fixes', () => {
  const oldScript = section(original, /<script>[\s\S]*?<\/script>/);
  const expected = oldScript
    .replace('const hour = String((now.getHours() % 12) || 12);', 'const hour = String(now.getHours()).padStart(2, "0");')
    .replace('      setInterval(() => updateOnlineUsers(0), 60 * 60 * 1000);\n', '')
    .replace('      const showMissionAlert = (reply) => {', `      missionAlert.addEventListener("animationend", (event) => {
        if (event.animationName !== "alertPop") return;
        missionAlert.classList.remove("is-visible");
        missionAlert.setAttribute("aria-hidden", "true");
      });

      const showMissionAlert = (reply) => {`);
  assert.notEqual(expected, oldScript);
  assert.ok(section(current, /<script>[\s\S]*?<\/script>/) === expected,
    'application behavior changed beyond the three reviewed fixes');
});

test('entry shows brand, verification and accessible status without redundant instructions', () => {
  const gate = section(current, /<section class="verification-gate"[\s\S]*?<\/section>/);
  for (const text of ['DropMMSSGG', 'Verify to enter', 'id="turnstileWidget"',
    'id="verificationStatus"', 'role="status"', 'aria-live="polite"', 'aria-modal="true"']) {
    assert.ok(gate.includes(text), `missing entry element: ${text}`);
  }
  for (const text of ['verification-gate__copy', 'verification-gate__trust',
    'verification-gate__eyebrow', 'verification-gate__brand-domain']) {
    assert.ok(!gate.includes(text), `redundant entry detail remains: ${text}`);
  }
});

test('existing action controls have clear labels without changed IDs or types', () => {
  for (const pattern of [
    /<button id="sendButton" type="submit">Send message<\/button>/,
    /id="keypadClear" type="button" aria-label="Clear calculator">C<\/button>/,
    /id="keypadDelete" type="button" aria-label="Delete last digit">DEL<\/button>/,
    /id="keypadSubmit" type="button" aria-label="Calculate">=<\/button>/,
  ]) assert.ok(pattern.test(current), 'action label or control contract changed');
});
