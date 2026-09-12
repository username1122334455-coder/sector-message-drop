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

test('entry cleanup preserves stylesheet and application behavior byte-for-byte', () => {
  for (const pattern of [/<style>[\s\S]*?<\/style>/, /<script>[\s\S]*?<\/script>/]) {
    assert.ok(section(current, pattern) === section(original, pattern), 'application code changed');
  }
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
