import assert from 'node:assert/strict';
import { createTauriStorage } from '../tauri-storage.js';

const records = new Map();
let itemReads = 0;
const store = {
    async tryGetJson({ key }) {
        if (key.startsWith('item_v2_')) itemReads++;
        await new Promise(resolve => setTimeout(resolve, 1));
        return records.has(key) ? { found: true, value: structuredClone(records.get(key)) } : { found: false };
    },
    async setJson({ key, value }) { records.set(key, structuredClone(value)); },
    async deleteJson({ key }) { records.delete(key); },
    async listKeys() { return [...records.keys()]; },
};
const host = { ready: Promise.resolve(), api: { extension: { store } } };
const create = () => createTauriStorage(value => String(value), () => host);
const storage = create();
const api = storage.request;
const add = (title, sortOrder) => api('/theaters', { method: 'POST', body: { title, rawSource: `正文-${title}`, sortOrder } });
const added = await Promise.all([add('A', 10), add('B', 20), add('C', 30)]);
assert.equal((await api('/theaters')).total, 3, 'concurrent writes must not lose index entries');
assert.equal(new Set(added.map(x => x.theater.id)).size, 3);
itemReads = 0;
await api('/theaters?limit=1');
assert.equal(itemReads, 0, 'listing must not read any theater body');
const [a, b, c] = added.map(x => x.theater);
await api(`/theaters/${a.id}/move`, { method: 'POST', body: { direction: 'up' } });
await api(`/theaters/${a.id}`, { method: 'PATCH', body: { title: 'A edited' } });
assert.deepEqual((await api('/theaters')).theaters.map(x => x.id), [c.id, a.id, b.id]);
await api('/theaters/reorder', { method: 'POST', body: { orderedIds: [b.id, a.id, c.id] } });
await api(`/theaters/${b.id}`, { method: 'PATCH', body: { tags: ['喜欢', '喜欢'] } });
assert.deepEqual((await api('/theaters')).theaters.map(x => x.id), [b.id, a.id, c.id]);
assert.equal((await api('/tags')).tags[0].count, 1);
assert.equal((await create().request('/theaters')).total, 3, 'new adapter must read persisted records');
const backup = await storage.exportItems();
assert.equal(backup.length, 3);
assert.equal((await api('/import', { method: 'POST', body: { format: 'theater-favorites-backup', theaters: backup } })).skipped, 3);
await assert.rejects(api('/theaters', { method: 'POST', body: { rawSource: a.rawSource } }), /已经收藏/);
assert.equal((await api('/theaters')).total, 3, 'queue must remain usable after a rejected operation');
await api(`/theaters/${a.id}`, { method: 'DELETE' });
assert.equal(records.has('item_v2_' + a.id), false, 'delete must remove the native record');
records.set('item_v2_orphan', { ...a, id: 'orphan', tags: [] });
await api('/storage/rebuild', { method: 'POST' });
assert.equal((await api('/theaters')).total, 3, 'rebuild must recover orphaned records');
records.set('item_v2_null', null);
assert.equal((await api('/storage/compact', { method: 'POST' })).deleted, 1);
assert.equal(records.has('item_v2_null'), false);
records.set('index-v2', { damaged: true });
await api('/storage/rebuild', { method: 'POST' });
assert.equal((await api('/theaters')).total, 3, 'rebuild must work even when the saved index is invalid');
await api('/storage', { method: 'DELETE' });
assert.equal((await api('/theaters')).total, 0);
assert.equal(records.size, 1);
console.log('tauri storage behavior regression: ok');
