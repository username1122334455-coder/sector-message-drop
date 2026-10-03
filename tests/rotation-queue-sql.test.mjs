import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const sql = await readFile(new URL('automation/sql/rotation-queue.sql', root), 'utf8');
const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();

// Reference fixture for a later operator-run database test. It is deliberately
// not executed by this test suite: production credentials must never make a
// normal local test mutate the database. A scoped test can run this body in a
// single connection and verify its result before the unconditional rollback.
const databaseFixtureTransaction = `
begin;
update dropmmssgg_rotation.config
set enabled = true,
    token_hash = pg_catalog.sha256(
      pg_catalog.convert_to(pg_catalog.repeat('a', 64), 'UTF8')
    )
where singleton;
insert into dropmmssgg_rotation.queue (visit_id, created_at)
values
  (900000000000000001, '2026-10-01T07:20:28.385393+00:00'),
  (900000000000000002, '2026-10-01T07:20:28.385394+00:00');
rollback;
`;

test('migration is additive, atomic, and leaves existing visit and drop rows alone', () => {
  assert.match(normalized, /^--[\s\S]* begin; /);
  assert.match(normalized, / notify pgrst, 'reload schema'; commit;$/);
  assert.doesNotMatch(normalized, /\b(?:update|delete from|truncate) public\.(?:visits|drops)\b/);
  assert.doesNotMatch(normalized, /insert into dropmmssgg_rotation\.queue[\s\S]*select[\s\S]*from public\.visits/);
});

test('private queue stores only durable event identity and acknowledgement state', () => {
  assert.match(normalized, /create schema if not exists dropmmssgg_rotation/);
  assert.match(normalized, /create table if not exists dropmmssgg_rotation\.queue \( event_id bigint generated always as identity primary key, visit_id bigint not null, created_at timestamptz not null, acked_at timestamptz, unique \(visit_id, created_at\) \)/);
  assert.doesNotMatch(normalized, /references public\.visits|on delete cascade/);
  for (const forbidden of ['ip_address', 'ip_hash', 'client_hash', 'user_agent', 'screen_size', 'platform', 'referrer', 'message']) {
    const table = normalized.match(/create table if not exists dropmmssgg_rotation\.queue \(([\s\S]*?)\);/)?.[1] ?? '';
    assert.equal(table.includes(forbidden), false, `queue must not store ${forbidden}`);
  }
});

test('pending polling has a partial event-order index', () => {
  assert.match(normalized, /create index if not exists queue_pending_event_id_idx on dropmmssgg_rotation\.queue \(event_id\) where acked_at is null/);
});

test('migration installs inactive and activation is a separate cutover step', () => {
  assert.match(normalized, /enabled boolean not null default false/);
  assert.match(normalized, /insert into dropmmssgg_rotation\.config \(singleton, enabled, token_hash\) values \(true, false, null\)/);
  assert.match(normalized, /from dropmmssgg_rotation\.config as c where c\.singleton and c\.enabled[\s\S]*return new/);
  assert.equal((normalized.match(/raise exception 'rotation unavailable'/g) ?? []).length, 2);
});

test('private schema and tables are RLS protected without public table grants', () => {
  assert.match(normalized, /revoke all on schema dropmmssgg_rotation from public, anon, authenticated/);
  assert.match(normalized, /alter table dropmmssgg_rotation\.config enable row level security/);
  assert.match(normalized, /alter table dropmmssgg_rotation\.queue enable row level security/);
  assert.match(normalized, /revoke all on table dropmmssgg_rotation\.config, dropmmssgg_rotation\.queue from public, anon, authenticated/);
  assert.doesNotMatch(normalized, /grant [^;]* on (?:table|schema) /);
});

test('token configuration starts empty and validation uses only a SHA-256 hash', () => {
  assert.match(normalized, /token_hash bytea/);
  assert.match(normalized, /octet_length\(token_hash\) = 32/);
  assert.match(normalized, /insert into dropmmssgg_rotation\.config \(singleton, enabled, token_hash\) values \(true, false, null\)/);
  assert.match(normalized, /length\(p_token\) = 64/);
  assert.match(normalized, /p_token ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(normalized, /token_hash = pg_catalog\.sha256\( pg_catalog\.convert_to\(p_token, 'utf8'\) \)/);
  assert.doesNotMatch(sql, /\b[0-9a-fA-F]{64}\b/);
});

test('every helper and RPC is SECURITY DEFINER with an empty search path', () => {
  assert.equal((normalized.match(/create or replace function/g) ?? []).length, 4);
  assert.equal((normalized.match(/security definer/g) ?? []).length, 4);
  assert.equal((normalized.match(/set search_path = ''/g) ?? []).length, 4);
});

test('AFTER INSERT trigger queues every non-click visit in the visit transaction', () => {
  assert.match(normalized, /create trigger dropmmssgg_rotation_enqueue_visit after insert on public\.visits for each row/);
  assert.match(normalized, /left\( coalesce\(new\.path, ''\), 6 \) = 'click:'/);
  assert.doesNotMatch(normalized, /lower\([\s\S]*new\.path/);
  assert.match(normalized, /insert into dropmmssgg_rotation\.queue \( visit_id, created_at \) values \( new\.id, new\.created_at \) on conflict \(visit_id, created_at\) do nothing/);
  assert.doesNotMatch(normalized, /after (?:update|delete) on public\.visits/);
});

test('pending RPC exposes only ordered identifiers and exact UTC microseconds', () => {
  assert.match(normalized, /function public\.dropmmssgg_rotation_pending\( p_token text \) returns table \( event_id text, visit_id text, created_at text \)/);
  assert.match(normalized, /where q\.acked_at is null order by q\.event_id limit 50/);
  assert.match(sql, /YYYY-MM-DD"T"HH24:MI:SS\.US"Z"/);
  assert.match(normalized, /function public\.dropmmssgg_rotation_pending[\s\S]*raise exception 'rotation unavailable'[\s\S]*token_matches\(p_token\)[\s\S]*errcode = '42501'[\s\S]*message = 'rotation authorization failed'/);
});

test('ack RPC is token checked, decimal safe, and idempotent for any existing event', () => {
  assert.match(normalized, /function public\.dropmmssgg_rotation_ack\( p_token text, p_event_id text \) returns boolean/);
  assert.match(normalized, /p_event_id !~ '\^\[1-9\]\[0-9\]\*\$'/);
  assert.match(normalized, /when numeric_value_out_of_range then return false/);
  assert.match(normalized, /if v_acked_at is not null then return true/);
  assert.doesNotMatch(normalized, /earlier\.event_id < v_event_id/);
  assert.match(normalized, /set acked_at = pg_catalog\.clock_timestamp\(\)/);
  assert.match(normalized, /function public\.dropmmssgg_rotation_ack[\s\S]*raise exception 'rotation unavailable'[\s\S]*token_matches\(p_token\)[\s\S]*errcode = '42501'[\s\S]*message = 'rotation authorization failed'/);
});

test('SQL special forms are not incorrectly schema-qualified', () => {
  assert.doesNotMatch(normalized, /pg_catalog\.coalesce/);
});

test('only token-gated RPC execution is granted outside the private owner', () => {
  assert.match(normalized, /grant execute on function public\.dropmmssgg_rotation_pending\(text\) to anon, service_role/);
  assert.match(normalized, /grant execute on function public\.dropmmssgg_rotation_ack\(text, text\) to anon, service_role/);
  assert.doesNotMatch(normalized, /grant execute on function dropmmssgg_rotation\./);
});

test('future database fixture is isolated, direct, and always rolled back', () => {
  const fixture = databaseFixtureTransaction.replace(/\s+/g, ' ').trim().toLowerCase();
  assert.match(fixture, /^begin;/);
  assert.match(fixture, /update dropmmssgg_rotation\.config set enabled = true, token_hash = pg_catalog\.sha256\( pg_catalog\.convert_to\(pg_catalog\.repeat\('a', 64\), 'utf8'\) \)/);
  assert.match(fixture, /insert into dropmmssgg_rotation\.queue/);
  assert.doesNotMatch(fixture, /(?:insert into|update|delete from) public\.(?:visits|drops)/);
  assert.match(fixture, /rollback;$/);
});
