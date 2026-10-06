// TauriTavern's native extension store; no browser database or Node plugin.
export function createTauriStorage(signature, getHost = () => window.__TAURITAVERN__) {
    const namespace = 'theater-favorites';
    const table = 'main';
    const indexKey = 'index-v2';
    const prefix = 'item_v2_';
    let queue = Promise.resolve();
    const serial = operation => {
        const result = queue.then(operation);
        queue = result.catch(() => {});
        return result;
    };
    const size = value => new TextEncoder().encode(JSON.stringify(value)).length;
    const signed = item => signature(item.rawSource || item.renderedHtml || item.plainText || '');
    const sorted = items => [...items].sort((a, b) => Number(b.sortOrder) - Number(a.sortOrder) || String(b.createdAt).localeCompare(String(a.createdAt)));
    const empty = () => ({ version: 2, nextSeq: 1, items: [] });
    const sourceLabel = item => item.sourceType === 'loreframe-html' ? '拟界文库'
        : item.sourceType === 'details' ? 'details' : item.sourceType === 'tag-markdown' ? 'Markdown'
        : item.sourceTag || (/html/i.test(item.sourceType || '') ? 'HTML' : item.sourceType || '其他');
    const tags = value => [...new Set(value.map(x => String(x).trim()).filter(Boolean))].slice(0, 20);
    const summary = item => {
        const { rawSource, renderedHtml, plainText, ...metadata } = item;
        return { ...metadata, signature: signed(item), sizeBytes: size(item) };
    };
    const refresh = (index, item) => {
        const position = index.items.findIndex(x => x.id === item.id);
        if (position < 0) index.items.push(summary(item));
        else index.items[position] = summary(item);
    };
    const tagStats = index => {
        const counts = new Map();
        index.items.forEach(x => new Set(x.tags || []).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1)));
        return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    };
    const list = (index, query) => {
        const search = (query.get('search') || '').trim().toLowerCase();
        const rows = sorted(index.items).filter(x =>
            (!search || [x.title, x.character?.name, x.chat?.name, ...(x.tags || [])].some(v => String(v || '').toLowerCase().includes(search))) &&
            (!query.get('character') || x.character?.name === query.get('character')) &&
            (!query.get('chat') || x.chat?.name === query.get('chat')) &&
            (!query.get('source') || sourceLabel(x) === query.get('source')) &&
            (!query.get('tag') || (x.tags || []).includes(query.get('tag'))));
        const unique = getter => [...new Set(index.items.flatMap(getter).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
        const offset = Math.max(0, Number(query.get('offset')) || 0);
        const limit = Math.max(1, Math.min(100, Number(query.get('limit')) || 20));
        return { ok: true, theaters: rows.slice(offset, offset + limit), total: rows.length,
            filters: { characters: unique(x => x.character?.name), chats: unique(x => x.chat?.name), sources: unique(sourceLabel), tags: unique(x => x.tags || []) } };
    };
    const normalize = (input, index) => {
        const now = new Date().toISOString();
        return { id: `tf_${Date.now()}_${index.nextSeq++}`, createdAt: now, updatedAt: now,
            sourceType: String(input.sourceType || 'rendered-snapshot'), sourceTag: String(input.sourceTag || ''),
            detailsSummary: String(input.detailsSummary || ''), title: String(input.title || input.detailsSummary || '未命名小剧场'),
            sortOrder: Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : Math.max(Date.now(), ...index.items.map(x => Number(x.sortOrder) + 1)),
            rawSource: String(input.rawSource || ''), renderedHtml: String(input.renderedHtml || ''), plainText: String(input.plainText || ''),
            chat: { name: String(input.chat?.name || ''), messageId: input.chat?.messageId ?? null },
            character: { id: input.character?.id ?? null, name: String(input.character?.name || ''), avatar: String(input.character?.avatar || '') },
            tags: Array.isArray(input.tags) ? tags(input.tags) : [] };
    };

    async function access(repair = false) {
        const host = getHost();
        await host.ready;
        const store = host.api?.extension?.store;
        if (!store) throw new Error('当前 TauriTavern 没有扩展存储接口，请更新 TauriTavern。');
        const get = async key => {
            const result = await store.tryGetJson({ namespace, table, key });
            return result.found ? result.value : null;
        };
        const put = (key, value) => store.setJson({ namespace, table, key, value });
        const remove = key => store.deleteJson({ namespace, table, key });
        const keys = () => store.listKeys({ namespace, table });
        let index;
        try {
            index = await get(indexKey) || empty();
            if (!Array.isArray(index.items) || !Number.isFinite(index.nextSeq)) throw new Error('收藏索引损坏，请重建索引。');
        } catch (error) {
            if (!repair) throw error;
            index = empty();
        }
        return { index, get, put, remove, keys };
    }

    const exportItems = () => serial(async () => {
        const { index, get } = await access();
        const items = [];
        for (const entry of sorted(index.items)) {
            const item = await get(prefix + entry.id);
            if (!item) throw new Error(`收藏“${entry.title}”正文缺失，请先重建索引。`);
            items.push(item);
        }
        return items;
    });

    const request = (path, options = {}) => serial(async () => {
        const method = String(options.method || 'GET').toUpperCase();
        const url = new URL(path, 'https://extension.invalid');
        const pathname = url.pathname;
        const { index, get, put, remove, keys } = await access(pathname === '/storage/rebuild' && method === 'POST');
        const body = options.body ? (typeof options.body === 'string' ? JSON.parse(options.body) : options.body) : {};
        const save = () => put(indexKey, index);
        const write = async item => {
            await put(prefix + item.id, item);
            refresh(index, item);
        };
        const requireItem = async id => {
            if (!index.items.some(x => x.id === id)) throw new Error('收藏不存在。');
            const item = await get(prefix + id);
            if (!item) throw new Error('收藏正文缺失，请先重建索引。');
            return item;
        };
        const storage = () => ({ ok: true, bytes: size(index) + index.items.reduce((n, x) => n + x.sizeBytes, 0),
            files: index.items.length + 1, total: index.items.length, deleted: 0, storageVersion: 'tt-android-2' });
        if (pathname === '/status') return { ok: true, total: index.items.length, storeDir: 'TauriTavern 原生扩展存储' };
        if (pathname === '/storage' && method === 'GET') return storage();
        if (pathname === '/storage' && method === 'DELETE') {
            for (const key of await keys()) if (key.startsWith(prefix) || key === indexKey) await remove(key);
            Object.assign(index, empty());
            await save();
            return storage();
        }
        if (['/storage/rebuild', '/storage/compact'].includes(pathname) && method === 'POST') {
            const rebuilt = [];
            let deleted = 0;
            for (const key of await keys()) {
                if (!key.startsWith(prefix)) continue;
                const item = await get(key);
                if (!item || !item.id) { await remove(key); deleted++; continue; }
                if (pathname === '/storage/compact' && !index.items.some(x => x.id === item.id)) {
                    await remove(key); deleted++; continue;
                }
                rebuilt.push(summary(item));
            }
            index.items = rebuilt;
            const sequences = rebuilt.map(x => Number(x.id.split('_').at(-1)) + 1).filter(Number.isFinite);
            index.nextSeq = Math.max(index.nextSeq, ...sequences);
            await save();
            return { ...storage(), deleted };
        }
        if (pathname === '/tags' && method === 'GET') return { ok: true, tags: tagStats(index) };
        if (pathname.startsWith('/tags/') && method === 'DELETE') {
            const tag = decodeURIComponent(pathname.slice(6));
            let updated = 0;
            for (const entry of [...index.items]) {
                if (!entry.tags.includes(tag)) continue;
                const item = await requireItem(entry.id);
                item.tags = item.tags.filter(x => x !== tag);
                item.updatedAt = new Date().toISOString();
                await write(item);
                updated++;
            }
            await save();
            return { ok: true, updated, tags: tagStats(index) };
        }
        if (pathname === '/theaters' && method === 'GET') return list(index, url.searchParams);
        if (pathname === '/theaters' && method === 'POST') {
            if (index.items.some(x => x.signature === signed(body))) throw new Error('这个小剧场已经收藏过了。');
            const item = normalize(body, index);
            await write(item);
            await save();
            return { ok: true, theater: item };
        }
        if (pathname === '/import' && method === 'POST') {
            if (body.format !== 'theater-favorites-backup' || !Array.isArray(body.theaters) || !body.theaters.every(x => x && typeof x === 'object' && !Array.isArray(x))) throw new Error('不是有效的小剧场收藏夹备份。');
            const signatures = new Set(index.items.map(x => x.signature));
            let imported = 0, skipped = 0;
            for (const input of body.theaters) {
                const sig = signed(input);
                if (signatures.has(sig)) { skipped++; continue; }
                const item = normalize(input, index);
                await write(item);
                // Commit each imported entry so an interrupted import can be resumed safely.
                await save();
                signatures.add(sig);
                imported++;
            }
            return { ok: true, imported, skipped, total: index.items.length };
        }
        if (pathname === '/theaters/reorder' && method === 'POST') {
            const ids = [...new Set(body.orderedIds || [])].filter(id => index.items.some(x => x.id === id));
            const ordered = sorted(index.items);
            const values = ordered.filter(x => ids.includes(x.id)).map(x => x.sortOrder);
            for (let i = 0; i < ids.length; i++) {
                const item = await requireItem(ids[i]);
                item.sortOrder = values[i];
                item.updatedAt = new Date().toISOString();
                await write(item);
            }
            await save();
            return { ok: true, reordered: ids.length > 1 };
        }
        const move = pathname.match(/^\/theaters\/([^/]+)\/move$/);
        if (move && method === 'POST') {
            const ordered = sorted(index.items);
            const i = ordered.findIndex(x => x.id === decodeURIComponent(move[1]));
            if (i < 0) throw new Error('收藏不存在。');
            const j = i + (body.direction === 'down' ? 1 : -1);
            if (j < 0 || j >= ordered.length) return { ...list(index, url.searchParams), moved: false };
            const a = await requireItem(ordered[i].id), b = await requireItem(ordered[j].id);
            [a.sortOrder, b.sortOrder] = [b.sortOrder, a.sortOrder];
            a.updatedAt = b.updatedAt = new Date().toISOString();
            await write(a); await write(b); await save();
            return { ...list(index, url.searchParams), moved: true };
        }
        const match = pathname.match(/^\/theaters\/([^/]+)$/);
        if (match) {
            const id = decodeURIComponent(match[1]);
            const item = await requireItem(id);
            if (method === 'GET') return { ok: true, theater: item };
            if (method === 'DELETE') {
                await remove(prefix + id);
                index.items = index.items.filter(x => x.id !== id);
                await save();
                return { ok: true };
            }
            if (method === 'PATCH') {
                for (const key of ['title', 'sourceType', 'sourceTag', 'detailsSummary', 'rawSource', 'renderedHtml', 'plainText']) {
                    if (body[key] !== undefined) item[key] = String(body[key]);
                }
                if (Array.isArray(body.tags)) item.tags = tags(body.tags);
                if (index.items.some(x => x.id !== id && x.signature === signed(item))) throw new Error('修改后的内容与已有收藏重复。');
                item.updatedAt = new Date().toISOString();
                await write(item); await save();
                return { ok: true, theater: item };
            }
        }
        throw new Error(`不支持的收藏操作：${method} ${pathname}`);
    });
    return { request, exportItems };
}
