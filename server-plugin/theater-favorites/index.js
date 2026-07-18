const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STORE_DIR = 'theater-favorites';
const INDEX_FILE = 'index.json';
const ITEMS_DIR = 'items';
const SHARD_PREFIX = 'theaters-';
const SHARD_SUFFIX = '.jsonl';
const MAX_SHARD_LINES = 1000;
const MAX_FIELD_LENGTH = 2000000;

function nowIso() {
    return new Date().toISOString();
}

function makeId(seq) {
    return `tf_${Date.now().toString(36)}_${String(seq).padStart(6, '0')}`;
}

function getStorePath(request) {
    if (!request.user?.directories?.root) {
        const error = new Error('小剧场收藏夹需要登录后的 SillyTavern 用户。');
        error.status = 403;
        throw error;
    }
    const userRoot = request.user.directories.root;
    const storePath = path.resolve(userRoot, STORE_DIR);
    const resolvedRoot = path.resolve(userRoot);
    if (!storePath.startsWith(resolvedRoot + path.sep)) {
        const error = new Error('存储路径越界。');
        error.status = 500;
        throw error;
    }
    fs.mkdirSync(storePath, { recursive: true });
    return storePath;
}

function getIndexPath(storePath) {
    return path.join(storePath, INDEX_FILE);
}

function shardName(number) {
    return `${SHARD_PREFIX}${String(number).padStart(4, '0')}${SHARD_SUFFIX}`;
}

function defaultIndex() {
    return {
        version: 3,
        nextSeq: 1,
        total: 0,
        items: [],
        updatedAt: nowIso(),
    };
}

function readIndex(storePath) {
    const indexPath = getIndexPath(storePath);
    if (!fs.existsSync(indexPath)) {
        const backupPath = `${indexPath}.bak`;
        if (fs.existsSync(backupPath)) {
            try {
                const backup = { ...defaultIndex(), ...JSON.parse(fs.readFileSync(backupPath, 'utf8')) };
                return rebuildIndex(storePath, backup);
            } catch {
                // Fall through to item-file recovery.
            }
        }
        return rebuildIndex(storePath);
    }
    try {
        const index = { ...defaultIndex(), ...JSON.parse(fs.readFileSync(indexPath, 'utf8')) };
        if (index.version < 2) return migrateLegacyStore(storePath, index);
        if (index.version < 3 || (index.items || []).some(item => !item.signature?.startsWith('sha256:'))) {
            return rebuildIndex(storePath, index);
        }
        return index;
    } catch (error) {
        const damagedPath = `${indexPath}.damaged-${Date.now()}`;
        try {
            if (fs.existsSync(indexPath)) fs.copyFileSync(indexPath, damagedPath);
        } catch {
            // Rebuilding from item files remains possible even if backup fails.
        }
        return rebuildIndex(storePath);
    }
}

function saveIndex(storePath, index) {
    index.version = 3;
    index.updatedAt = nowIso();
    const indexPath = getIndexPath(storePath);
    const tempPath = `${indexPath}.tmp`;
    const backupPath = `${indexPath}.bak`;
    fs.writeFileSync(tempPath, JSON.stringify(index, null, 2), 'utf8');
    if (fs.existsSync(indexPath)) fs.copyFileSync(indexPath, backupPath);
    try {
        fs.renameSync(tempPath, indexPath);
    } catch {
        fs.rmSync(indexPath, { force: true });
        fs.renameSync(tempPath, indexPath);
    }
}

function getItemsPath(storePath) {
    const itemsPath = path.join(storePath, ITEMS_DIR);
    fs.mkdirSync(itemsPath, { recursive: true });
    return itemsPath;
}

function itemFileName(id) {
    const safeId = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) throw new Error('Invalid theater id.');
    return `${safeId}.json`;
}

function writeTheaterFile(storePath, theater) {
    const itemsPath = getItemsPath(storePath);
    const filePath = path.join(itemsPath, itemFileName(theater.id));
    const tempPath = `${filePath}.tmp`;
    const serialized = JSON.stringify(theater);
    fs.writeFileSync(tempPath, serialized, 'utf8');
    fs.rmSync(filePath, { force: true });
    fs.renameSync(tempPath, filePath);
    return Buffer.byteLength(serialized, 'utf8');
}

function truncate(value, limit = MAX_FIELD_LENGTH) {
    const text = String(value || '');
    return text.length > limit ? text.slice(0, limit) : text;
}

function cleanText(value, limit = 20000) {
    return truncate(value, limit).replace(/\u0000/g, '');
}

function cleanFullText(value) {
    return String(value || '').replace(/\u0000/g, '');
}

function normalizeTheater(input, index) {
    const now = nowIso();
    return {
        id: makeId(index.nextSeq),
        createdAt: now,
        updatedAt: now,
        sourceType: cleanText(input.sourceType || 'rendered-snapshot', 80),
        sourceTag: cleanText(input.sourceTag || '', 80),
        detailsSummary: cleanText(input.detailsSummary || '', 300),
        title: cleanText(input.title || input.detailsSummary || '未命名小剧场', 300),
        sortOrder: Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : Date.now(),
        rawSource: cleanFullText(input.rawSource || ''),
        renderedHtml: cleanFullText(input.renderedHtml || ''),
        plainText: cleanFullText(input.plainText || ''),
        chat: {
            name: cleanText(input.chat?.name || '', 300),
            messageId: input.chat?.messageId ?? null,
        },
        character: {
            id: input.character?.id ?? null,
            name: cleanText(input.character?.name || '', 300),
            avatar: cleanText(input.character?.avatar || '', 500),
        },
        tags: Array.isArray(input.tags) ? input.tags.map(tag => cleanText(tag, 60)).slice(0, 20) : [],
    };
}

function appendTheater(storePath, index, theater, persist = true) {
    const sizeBytes = writeTheaterFile(storePath, theater);
    index.nextSeq += 1;
    index.items.push(listSummary(theater, sizeBytes));
    index.total = index.items.length;
    if (persist) saveIndex(storePath, index);
}

function getDeletedSet(index) {
    return new Set(Array.isArray(index.deleted) ? index.deleted : []);
}

function summary(theater) {
    return {
        id: theater.id,
        createdAt: theater.createdAt,
        updatedAt: theater.updatedAt,
        sortOrder: theater.sortOrder,
        sourceType: theater.sourceType,
        sourceTag: theater.sourceTag,
        detailsSummary: theater.detailsSummary,
        title: theater.title,
        rawSource: theater.rawSource,
        renderedHtml: theater.renderedHtml,
        plainText: theater.plainText,
        chat: theater.chat,
        character: theater.character,
        tags: theater.tags || [],
    };
}

function signature(value) {
    return `sha256:${crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
}

function listSummary(theater, sizeBytes = 0) {
    return {
        id: theater.id,
        createdAt: theater.createdAt,
        updatedAt: theater.updatedAt,
        sortOrder: theater.sortOrder,
        sourceType: theater.sourceType,
        sourceTag: theater.sourceTag,
        detailsSummary: theater.detailsSummary,
        title: theater.title,
        chat: theater.chat,
        character: theater.character,
        tags: theater.tags || [],
        signature: signature(theater.rawSource || theater.plainText || theater.renderedHtml || ''),
        sizeBytes,
    };
}

function displayOrderValue(item) {
    const explicit = Number(item?.sortOrder);
    if (Number.isFinite(explicit)) return explicit;
    const created = Date.parse(item?.createdAt || '');
    return Number.isFinite(created) ? created : 0;
}

function compareDisplayItems(left, right) {
    return displayOrderValue(right) - displayOrderValue(left)
        || String(right.createdAt || '').localeCompare(String(left.createdAt || ''))
        || String(right.id || '').localeCompare(String(left.id || ''));
}

function rebuildIndex(storePath, previousIndex = null) {
    const items = [];
    let highestSequence = 0;
    for (const name of fs.readdirSync(getItemsPath(storePath)).filter(file => file.endsWith('.json'))) {
        const filePath = path.join(getItemsPath(storePath), name);
        try {
            const theater = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (!theater?.id) continue;
            items.push(listSummary(theater, fs.statSync(filePath).size));
            const sequence = Number(String(theater.id).match(/_(\d+)$/)?.[1] || 0);
            highestSequence = Math.max(highestSequence, sequence);
        } catch {
            // A damaged item is left on disk so the user can recover it manually.
        }
    }
    items.sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
    const rebuilt = {
        ...defaultIndex(),
        nextSeq: Math.max(Number(previousIndex?.nextSeq) || 1, highestSequence + 1, items.length + 1),
        total: items.length,
        items,
    };
    saveIndex(storePath, rebuilt);
    return rebuilt;
}

function matches(theater, query = {}) {
    const search = String(query.search || '').trim().toLowerCase();
    if (!search) return true;
    return [
        theater.title,
        theater.plainText,
        theater.rawSource,
        theater.character?.name,
        theater.chat?.name,
    ].some(value => String(value || '').toLowerCase().includes(search));
}

function readTheaters(storePath, index, query = {}) {
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 20));
    const offset = Math.max(0, Number(query.offset) || 0);
    const search = String(query.search || '').trim().toLowerCase();
    const character = String(query.character || '').trim();
    const chat = String(query.chat || '').trim();
    const source = String(query.source || '').trim();
    const tag = String(query.tag || '').trim();
    const rows = [...(index.items || [])].sort(compareDisplayItems).filter(item => {
        if (search && ![item.title, item.character?.name, item.chat?.name, ...(item.tags || [])]
            .some(value => String(value || '').toLowerCase().includes(search))) return false;
        if (character && String(item.character?.name || '') !== character) return false;
        if (chat && String(item.chat?.name || '') !== chat) return false;
        if (source && sourceLabel(item) !== source) return false;
        if (tag && !(item.tags || []).includes(tag)) return false;
        return true;
    });

    return {
        theaters: rows.slice(offset, offset + limit),
        total: rows.length,
        filters: {
            characters: uniqueValues(index.items, item => item.character?.name),
            chats: uniqueValues(index.items, item => item.chat?.name),
            sources: uniqueValues(index.items, sourceLabel),
            tags: uniqueValues(index.items, item => item.tags || []),
        },
    };
}

function sourceLabel(item) {
    if (item.sourceType === 'loreframe-html') return '拟界文库';
    if (item.sourceType === 'details') return 'details';
    if (item.sourceTag) return item.sourceTag;
    if (/html/i.test(item.sourceType || '') || /<html|<!doctype/i.test(item.rawSource || '')) return 'HTML';
    return item.sourceType || '其他';
}

function uniqueValues(items, getter) {
    const values = new Set();
    (items || []).forEach(item => {
        const result = getter(item);
        (Array.isArray(result) ? result : [result]).forEach(value => {
            if (String(value || '').trim()) values.add(String(value).trim());
        });
    });
    return [...values].sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function readAllTheaters(storePath, index) {
    return (index.items || []).map(item => readTheater(storePath, index, item.id)).filter(Boolean);
}

function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function readTheater(storePath, index, id) {
    if (!id || !(index.items || []).some(item => item.id === id)) return null;
    const filePath = path.join(getItemsPath(storePath), itemFileName(id));
    if (!fs.existsSync(filePath)) return null;
    try {
        return summary(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch {
        return null;
    }
}

function updateIndexItem(storePath, index, theater) {
    const sizeBytes = writeTheaterFile(storePath, theater);
    const position = (index.items || []).findIndex(item => item.id === theater.id);
    if (position >= 0) index.items[position] = listSummary(theater, sizeBytes);
    return sizeBytes;
}

function moveTheater(storePath, index, id, direction) {
    const ordered = [...(index.items || [])].sort(compareDisplayItems);
    const current = ordered.findIndex(item => item.id === id);
    const target = current + direction;
    if (current < 0) {
        const error = new Error('收藏不存在。');
        error.status = 404;
        throw error;
    }
    if (target < 0 || target >= ordered.length) return { moved: false, index };

    const currentTheater = readTheater(storePath, index, ordered[current].id);
    const targetTheater = readTheater(storePath, index, ordered[target].id);
    if (!currentTheater || !targetTheater) {
        const error = new Error('收藏文件缺失，无法调整顺序。');
        error.status = 404;
        throw error;
    }

    const currentOrder = displayOrderValue(ordered[current]);
    const targetOrder = displayOrderValue(ordered[target]);
    currentTheater.sortOrder = targetOrder;
    targetTheater.sortOrder = currentOrder;
    currentTheater.updatedAt = nowIso();
    targetTheater.updatedAt = nowIso();
    updateIndexItem(storePath, index, currentTheater);
    updateIndexItem(storePath, index, targetTheater);
    saveIndex(storePath, index);
    return { moved: true, index };
}

function reorderTheaters(storePath, index, orderedIds = []) {
    const uniqueIds = [...new Set((orderedIds || []).map(id => String(id || '').trim()).filter(Boolean))];
    if (uniqueIds.length < 2) return { reordered: false, index };
    const existingIds = new Set((index.items || []).map(item => item.id));
    const ids = uniqueIds.filter(id => existingIds.has(id));
    if (ids.length < 2) return { reordered: false, index };

    const ordered = [...(index.items || [])].sort(compareDisplayItems);
    const visiblePositions = ids
        .map(id => ordered.findIndex(item => item.id === id))
        .filter(position => position >= 0)
        .sort((left, right) => left - right);
    if (visiblePositions.length !== ids.length) return { reordered: false, index };

    const orderValues = visiblePositions.map(position => displayOrderValue(ordered[position]));
    ids.forEach((id, offset) => {
        const theater = readTheater(storePath, index, id);
        if (!theater) return;
        theater.sortOrder = orderValues[offset];
        theater.updatedAt = nowIso();
        updateIndexItem(storePath, index, theater);
    });
    saveIndex(storePath, index);
    return { reordered: true, index };
}

function getStorageStats(storePath, index) {
    const indexBytes = fs.existsSync(getIndexPath(storePath)) ? fs.statSync(getIndexPath(storePath)).size : 0;
    const itemFiles = fs.readdirSync(getItemsPath(storePath)).filter(name => name.endsWith('.json'));
    const itemBytes = itemFiles.reduce((total, name) => total + fs.statSync(path.join(getItemsPath(storePath), name)).size, 0);
    return {
        bytes: indexBytes + itemBytes,
        files: itemFiles.length + 1,
        total: (index.items || []).length,
        deleted: 0,
        storageVersion: 3,
    };
}

function readActiveTheaters(storePath, index) {
    const deleted = getDeletedSet(index);
    const theaters = [];
    for (let shard = 1; shard <= index.currentShard; shard += 1) {
        const filePath = path.join(storePath, shardName(shard));
        if (!fs.existsSync(filePath)) continue;
        for (const line of fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)) {
            try {
                const theater = JSON.parse(line);
                if (!deleted.has(theater.id)) theaters.push(theater);
            } catch {
                // Damaged records are excluded from the compacted store.
            }
        }
    }
    return theaters;
}

function migrateLegacyStore(storePath, legacyIndex) {
    const theaters = readActiveTheaters(storePath, legacyIndex);
    const items = theaters.map(theater => listSummary(theater, writeTheaterFile(storePath, theater)));
    const migrated = {
        version: 3,
        nextSeq: Math.max(Number(legacyIndex.nextSeq) || 1, items.length + 1),
        total: items.length,
        items,
        updatedAt: nowIso(),
    };
    saveIndex(storePath, migrated);
    fs.readdirSync(storePath)
        .filter(name => name.startsWith(SHARD_PREFIX) && (name.endsWith(SHARD_SUFFIX) || name.endsWith('.compact')))
        .forEach(name => fs.rmSync(path.join(storePath, name), { force: true }));
    return migrated;
}

function compactStore(storePath, index) {
    const activeNames = new Set((index.items || []).map(item => itemFileName(item.id)));
    fs.readdirSync(getItemsPath(storePath)).forEach(name => {
        if ((name.endsWith('.json') && !activeNames.has(name)) || name.endsWith('.tmp')) {
            fs.rmSync(path.join(getItemsPath(storePath), name), { force: true });
        }
    });
    fs.readdirSync(storePath)
        .filter(name => name.startsWith(SHARD_PREFIX) && (name.endsWith(SHARD_SUFFIX) || name.endsWith('.compact')))
        .forEach(name => fs.rmSync(path.join(storePath, name), { force: true }));
    index.items = (index.items || []).filter(item => {
        const filePath = path.join(getItemsPath(storePath), itemFileName(item.id));
        return fs.existsSync(filePath);
    }).map(item => {
        const filePath = path.join(getItemsPath(storePath), itemFileName(item.id));
        return { ...item, sizeBytes: fs.statSync(filePath).size };
    });
    index.total = index.items.length;
    saveIndex(storePath, index);
    return index;
}

function clearStore(storePath) {
    const itemsPath = path.join(storePath, ITEMS_DIR);
    if (fs.existsSync(itemsPath)) fs.rmSync(itemsPath, { recursive: true, force: true });
    fs.readdirSync(storePath)
        .filter(name => name.startsWith(SHARD_PREFIX) && (name.endsWith(SHARD_SUFFIX) || name.endsWith('.compact')))
        .forEach(name => fs.rmSync(path.join(storePath, name), { force: true }));
    const index = defaultIndex();
    saveIndex(storePath, index);
    return index;
}

function handleError(response, error) {
    response.status(error.status || 500).json({ ok: false, error: error.message || String(error) });
}

async function init(router) {
    router.get('/status', (request, response) => {
        try {
            const storePath = getStorePath(request);
            const index = readIndex(storePath);
            response.json({ ok: true, total: index.total - getDeletedSet(index).size, storeDir: STORE_DIR });
        } catch (error) {
            handleError(response, error);
        }
    });

    router.get('/storage', (request, response) => {
        try {
            const storePath = getStorePath(request);
            const index = readIndex(storePath);
            response.json({ ok: true, ...getStorageStats(storePath, index) });
        } catch (error) {
            handleError(response, error);
        }
    });

    router.post('/storage/compact', (request, response) => {
        try {
            const storePath = getStorePath(request);
            const index = compactStore(storePath, readIndex(storePath));
            response.json({ ok: true, ...getStorageStats(storePath, index) });
        } catch (error) {
            handleError(response, error);
        }
    });

    router.post('/storage/rebuild', (request, response) => {
        try {
            const storePath = getStorePath(request);
            const index = rebuildIndex(storePath, readIndex(storePath));
            response.json({ ok: true, ...getStorageStats(storePath, index) });
        } catch (error) {
            handleError(response, error);
        }
    });

    router.delete('/storage', (request, response) => {
        try {
            const storePath = getStorePath(request);
            const index = clearStore(storePath);
            response.json({ ok: true, ...getStorageStats(storePath, index) });
        } catch (error) {
            handleError(response, error);
        }
    });

    router.get('/theaters', (request, response) => {
        try {
            const storePath = getStorePath(request);
            const index = readIndex(storePath);
            response.json({ ok: true, ...readTheaters(storePath, index, request.query || {}) });
        } catch (error) {
            handleError(response, error);
        }
    });

    router.get('/export/backup', (request, response) => {
        try {
            const storePath = getStorePath(request);
            const index = readIndex(storePath);
            const backup = { format: 'theater-favorites-backup', version: 1, exportedAt: nowIso(), theaters: readAllTheaters(storePath, index) };
            response.setHeader('Content-Disposition', `attachment; filename="theater-favorites-${Date.now()}.json"`);
            response.type('application/json').send(JSON.stringify(backup));
        } catch (error) { handleError(response, error); }
    });

    router.get('/export/html', (request, response) => {
        try {
            const storePath = getStorePath(request);
            const index = readIndex(storePath);
            const articles = readAllTheaters(storePath, index).map((item, offset) => {
                const content = item.rawSource || item.renderedHtml || `<pre>${escapeHtml(item.plainText)}</pre>`;
                return `<article><button class="title" onclick="toggle(this)"><b>${offset + 1}</b><span>${escapeHtml(item.title)}</span></button><section><p>${escapeHtml([sourceLabel(item), item.character?.name, item.chat?.name].filter(Boolean).join(' · '))}</p><iframe sandbox="allow-scripts allow-forms" srcdoc="${escapeHtml(content)}"></iframe></section></article>`;
            }).join('');
            const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小剧场收藏夹</title><style>body{max-width:980px;margin:auto;padding:24px;background:#11131b;color:#eee;font:16px/1.6 system-ui}article{border-bottom:1px solid #333}.title{display:flex;gap:12px;width:100%;padding:16px;border:0;background:none;color:inherit;text-align:left;font:inherit;cursor:pointer}.title b{color:#e7cb8c}section{display:none;padding:0 16px 20px}article.open section{display:block}p{color:#aaa}iframe{width:100%;height:75vh;border:0;background:#fff}</style></head><body><h1>小剧场收藏夹</h1><p>${index.items.length} 条收藏 · 导出于 ${escapeHtml(nowIso())}</p>${articles}<script>function toggle(button){var article=button.parentElement;document.querySelectorAll('article.open').forEach(x=>{if(x!==article)x.classList.remove('open')});article.classList.toggle('open')}</script></body></html>`;
            response.setHeader('Content-Disposition', `attachment; filename="theater-favorites-${Date.now()}.html"`);
            response.type('text/html').send(html);
        } catch (error) { handleError(response, error); }
    });

    router.post('/import', (request, response) => {
        try {
            const payload = request.body || {};
            if (payload.format !== 'theater-favorites-backup' || !Array.isArray(payload.theaters)) {
                return response.status(400).json({ ok: false, error: '不是有效的小剧场收藏夹备份。' });
            }
            const storePath = getStorePath(request);
            const index = readIndex(storePath);
            const signatures = new Set((index.items || []).map(item => item.signature));
            let imported = 0; let skipped = 0;
            for (const input of payload.theaters) {
                const theater = normalizeTheater(input, index);
                const itemSignature = signature(theater.rawSource || theater.renderedHtml || theater.plainText || '');
                if (signatures.has(itemSignature)) { skipped += 1; continue; }
                appendTheater(storePath, index, theater, false);
                signatures.add(itemSignature); imported += 1;
            }
            if (imported) saveIndex(storePath, index);
            response.json({ ok: true, imported, skipped, total: index.total });
        } catch (error) { handleError(response, error); }
    });

    router.patch('/theaters/:id', (request, response) => {
        try {
            const storePath = getStorePath(request);
            const index = readIndex(storePath);
            const id = String(request.params.id || '');
            const theater = readTheater(storePath, index, id);
            if (!theater) return response.status(404).json({ ok: false, error: '收藏不存在。' });

            const body = request.body || {};
            theater.title = cleanText(body.title ?? theater.title, 300);
            theater.tags = Array.isArray(body.tags) ? body.tags.map(tag => cleanText(tag, 60)).filter(Boolean).slice(0, 20) : theater.tags;
            theater.sourceType = body.sourceType !== undefined ? cleanText(body.sourceType || 'edited', 80) : theater.sourceType;
            theater.sourceTag = body.sourceTag !== undefined ? cleanText(body.sourceTag || '', 80) : theater.sourceTag;
            theater.detailsSummary = body.detailsSummary !== undefined ? cleanText(body.detailsSummary || '', 300) : theater.detailsSummary;
            theater.rawSource = body.rawSource !== undefined ? cleanFullText(body.rawSource) : theater.rawSource;
            theater.renderedHtml = body.renderedHtml !== undefined ? cleanFullText(body.renderedHtml) : theater.renderedHtml;
            theater.plainText = body.plainText !== undefined ? cleanFullText(body.plainText) : theater.plainText;

            const nextSignature = signature(theater.rawSource || theater.renderedHtml || theater.plainText || '');
            const duplicate = (index.items || []).find(item => item.id !== id && item.signature === nextSignature);
            if (duplicate) {
                return response.status(409).json({ ok: false, error: '编辑后的内容和另一条收藏重复。', duplicateId: duplicate.id });
            }

            theater.updatedAt = nowIso();
            const sizeBytes = updateIndexItem(storePath, index, theater);
            saveIndex(storePath, index);
            response.json({ ok: true, theater: { ...summary(theater), signature: signature(theater.rawSource || theater.renderedHtml || theater.plainText || ''), sizeBytes } });
        } catch (error) { handleError(response, error); }
    });

    router.post('/theaters/:id/move', (request, response) => {
        try {
            const storePath = getStorePath(request);
            const index = readIndex(storePath);
            const direction = String(request.body?.direction || '') === 'down' ? 1 : -1;
            const result = moveTheater(storePath, index, String(request.params.id || ''), direction);
            response.json({ ok: true, moved: result.moved, ...readTheaters(storePath, result.index, request.query || {}) });
        } catch (error) {
            handleError(response, error);
        }
    });

    router.post('/theaters/reorder', (request, response) => {
        try {
            const storePath = getStorePath(request);
            const index = readIndex(storePath);
            const result = reorderTheaters(storePath, index, request.body?.orderedIds || []);
            response.json({ ok: true, reordered: result.reordered });
        } catch (error) {
            handleError(response, error);
        }
    });

    router.get('/theaters/:id', (request, response) => {
        try {
            const storePath = getStorePath(request);
            const index = readIndex(storePath);
            const theater = readTheater(storePath, index, String(request.params.id || ''));
            if (!theater) return response.status(404).json({ ok: false, error: '收藏不存在。' });
            response.json({ ok: true, theater });
        } catch (error) {
            handleError(response, error);
        }
    });

    router.post('/theaters', (request, response) => {
        try {
            const storePath = getStorePath(request);
            const index = readIndex(storePath);
            const theater = normalizeTheater(request.body || {}, index);
            const theaterSignature = signature(theater.rawSource || theater.renderedHtml || theater.plainText || '');
            const existing = (index.items || []).find(item => item.signature === theaterSignature);
            if (existing) {
                return response.status(409).json({ ok: false, error: '这个小剧场已经收藏过了。', duplicateId: existing.id });
            }
            appendTheater(storePath, index, theater);
            response.json({ ok: true, theater: summary(theater) });
        } catch (error) {
            handleError(response, error);
        }
    });

    router.delete('/theaters/:id', (request, response) => {
        try {
            const storePath = getStorePath(request);
            const index = readIndex(storePath);
            const id = String(request.params.id || '');
            const itemIndex = (index.items || []).findIndex(item => item.id === id);
            if (itemIndex >= 0) {
                index.items.splice(itemIndex, 1);
                index.total = index.items.length;
                saveIndex(storePath, index);
                fs.rmSync(path.join(getItemsPath(storePath), itemFileName(id)), { force: true });
            } else {
                saveIndex(storePath, index);
            }
            response.json({ ok: true });
        } catch (error) {
            handleError(response, error);
        }
    });
}

module.exports = {
    init,
    info: {
        id: 'theater-favorites',
        name: '小剧场收藏夹',
        version: '0.4.0',
        description: 'Collects theater snippets into per-user local files with a lightweight index.',
    },
};
