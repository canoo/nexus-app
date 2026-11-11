import test from 'node:test';
import assert from 'node:assert/strict';
import { startCompanionRetentionMaintenance } from '../lib/host.mjs';
test('host maintenance is immediate, periodic, silent and does not keep process alive',()=>{
 let runs=0,tick,unreferenced=false,cancelled=false;const timer={unref(){unreferenced=true;}};
 const stop=startCompanionRetentionMaintenance({pruneToolActivity(){runs++;throw new Error('private');}},{schedule(callback,interval){assert.equal(interval,1800000);tick=callback;return timer;},cancel(value){assert.equal(value,timer);cancelled=true;}});
 assert.equal(runs,1);tick();assert.equal(runs,2);assert.equal(unreferenced,true);stop();assert.equal(cancelled,true);assert.doesNotThrow(()=>startCompanionRetentionMaintenance({})());
});
