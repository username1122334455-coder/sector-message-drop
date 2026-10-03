import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState, processNextEvent } from '../automation/rotation-controller.mjs';

const event = (id, date = '2026-10-01T07:20:28.385393+00:00') => ({ event_id: String(id), visit_id: String(id), created_at: date });
const initial = () => normalizeState({ version: 3, currentFolder: 2, lastProcessedVisit: '2026-10-01T07:20:28.385393+00:00' });
function fixture(queue) {
  const saved = []; const publications = []; const acknowledgements = [];
  return { saved, publications, acknowledgements,
    events: async () => queue,
    ready: async () => ({ ok: true }),
    publish: async (p) => { publications.push(structuredClone(p)); return { ok: true, eventId: p.event.event_id, revision:'a'.repeat(40),remoteConfirmed:true,publication:{ok:true,checkedAt:'2026-10-02T00:00:00Z',sourceDigest:'b'.repeat(64)} }; },
    acknowledge: async (id) => { acknowledgements.push(id); const i = queue.findIndex(e => e.event_id === id); if (i >= 0) queue.splice(i, 1); return true; },
    save: async state => { saved.push(structuredClone(state)); },
  };
}
test('migration preserves exact checkpoint and does not replay old visits', async () => {
  const state = initial(); const f = fixture([]);
  assert.equal((await processNextEvent(state, f)).reason, 'idle');
  assert.equal(state.currentFolder, 2); assert.equal(state.lastProcessedVisit, '2026-10-01T07:20:28.385393+00:00');
  assert.equal(f.publications.length, 0);
});
test('three burst events each rotate once, including sub-millisecond timestamps', async () => {
  const state = initial(); const f = fixture([event(1, '2026-10-01T07:20:28.385100Z'), event(2, '2026-10-01T07:20:28.385200Z'), event(3, '2026-10-01T07:20:28.385300Z')]);
  for (let i=0;i<3;i++) await processNextEvent(state,f);
  assert.deepEqual(f.publications.map(p=>p.folder), [3,1,2]);
  assert.deepEqual(f.acknowledgements, ['1','2','3']);
});
test('unready folder retains event and retries same next folder', async () => {
  const state=initial();const f=fixture([event(1)]);f.ready=async()=>({ok:false});
  assert.equal((await processNextEvent(state,f)).reason,'folder-not-ready');
  assert.equal(state.currentFolder,2);assert.equal(f.acknowledgements.length,0);
  f.ready=async()=>({ok:true});await processNextEvent(state,f);
  assert.equal(state.currentFolder,3);assert.deepEqual(f.acknowledgements,['1']);
});
test('failed publication keeps durable intent and never acknowledges', async () => {
  const state=initial();const f=fixture([event(1)]);f.publish=async()=>{throw new Error('timeout');};
  await assert.rejects(processNextEvent(state,f),/timeout/);
  assert.equal(state.currentFolder,2);assert.equal(state.pending.event.event_id,'1');
  assert.equal(f.saved.at(-1).pending.phase,'publishing');assert.equal(f.acknowledgements.length,0);
});
test('ambiguous ack recovers same event after restart without selecting next folder', async () => {
  let state=initial();const f=fixture([event(1),event(2)]);const ack=f.acknowledge;
  f.acknowledge=async id=>{await ack(id);throw new Error('connection lost');};
  await assert.rejects(processNextEvent(state,f),/connection lost/);
  state=normalizeState(f.saved.at(-1));f.acknowledge=ack;
  await processNextEvent(state,f);
  assert.equal(state.currentFolder,3);assert.equal(state.lastProcessedEvent,'1');
  assert.deepEqual(f.publications.map(p=>p.event.event_id),['1','1']);
});
test('late committed lower ID is processed; no high-water timestamp or ID skips', async () => {
  const state=initial();const queue=[event(10)];const f=fixture(queue);
  await processNextEvent(state,f);queue.push(event(9));await processNextEvent(state,f);
  assert.deepEqual(f.acknowledgements,['10','9']);
});
test('state save failure before publish cannot create publication', async () => {
  const state=initial();const f=fixture([event(1)]);f.save=async()=>{throw new Error('disk');};
  await assert.rejects(processNextEvent(state,f),/disk/);assert.equal(f.publications.length,0);
});
test('history deletion does not remove already queued work', async () => {
  const state=initial();const f=fixture([event(1)]);await processNextEvent(state,f);
  assert.equal(state.lastProcessedEvent,'1');
});
test('bigint IDs remain strings without precision loss', async()=>{
  const state=initial();const f=fixture([event('9007199254740999')]);await processNextEvent(state,f);
  assert.equal(state.lastProcessedEvent,'9007199254740999');
});
test('invalid or missing state fails closed',()=>{
  for(const input of [null,{}, {version:3,currentFolder:9,lastProcessedVisit:null}]) assert.throws(()=>normalizeState(input));
});
test('wrong-event or partial publication receipt cannot acknowledge a visit',async()=>{
  for(const transform of [r=>({...r,eventId:'99'}),r=>({ok:true}),r=>({...r,remoteConfirmed:false}),r=>({...r,publication:{ok:false}})]){
    const state=initial();const f=fixture([event(1)]);const publish=f.publish;f.publish=async p=>transform(await publish(p));
    await assert.rejects(processNextEvent(state,f),/does not match/);assert.equal(f.acknowledgements.length,0);assert.equal(state.currentFolder,2);
  }
});
test('save failure after public delivery but before ACK safely retries the same event',async()=>{
  let state=initial();const f=fixture([event(1)]);const save=f.save;
  f.save=async s=>{if(s.pending?.phase==='published') throw new Error('disk');await save(s);};
  await assert.rejects(processNextEvent(state,f),/disk/);assert.equal(f.acknowledgements.length,0);
  state=normalizeState(f.saved.at(-1));f.save=save;await processNextEvent(state,f);assert.equal(state.currentFolder,3);
});
test('save failure after ACK recovers the checkpoint without processing another event',async()=>{
  let state=initial();const f=fixture([event(1),event(2)]);const save=f.save;
  f.save=async s=>{if(s.pending===null) throw new Error('disk');await save(s);};
  await assert.rejects(processNextEvent(state,f),/disk/);
  state=normalizeState(f.saved.at(-1));f.save=save;await processNextEvent(state,f);
  assert.equal(state.currentFolder,3);assert.deepEqual(f.publications.map(p=>p.event.event_id),['1','1']);
});
