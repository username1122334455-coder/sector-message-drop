import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, stat, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { atomicJson, readRotationToken, makeRotationRpc } from '../automation/rotation-io.mjs';

test('atomic checkpoint saves complete owner-only JSON without leftover staging files',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'drop-rotation-io-'));const file=path.join(dir,'state.json');
  await atomicJson(file,{version:5,currentFolder:2});await atomicJson(file,{version:5,currentFolder:3});
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{version:5,currentFolder:3});
  assert.equal((await stat(file)).mode&0o777,0o600);assert.deepEqual(await readdir(dir),['state.json']);
});
test('rotation credential refuses unsafe permissions, symlinks, and invalid content',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'drop-rotation-token-'));const file=path.join(dir,'token');
  await writeFile(file,'a'.repeat(64),{mode:0o600});assert.equal(await readRotationToken(file),'a'.repeat(64));
  await chmod(file,0o644);await assert.rejects(readRotationToken(file),/owner-only/);
  await chmod(file,0o600);await symlink(file,path.join(dir,'link'));await assert.rejects(readRotationToken(path.join(dir,'link')),/owner-only/);
  await writeFile(file,'invalid');await assert.rejects(readRotationToken(file),/Invalid/);
});
test('RPC errors never expose response body or token',async()=>{
  const original=globalThis.fetch;const secret='z'.repeat(64);
  globalThis.fetch=async()=>new Response(secret,{status:403});
  try{const rpc=makeRotationRpc({url:'https://example.invalid',publishableKey:'public',token:secret});
    await assert.rejects(rpc('dropmmssgg_rotation_pending'),error=>error.message==='Rotation RPC dropmmssgg_rotation_pending returned HTTP 403');
  }finally{globalThis.fetch=original;}
});
