import {
    chat,
    characters,
    eventSource,
    event_types,
    getCurrentChatId,
    getRequestHeaders,
    this_chid,
} from '../../../../script.js';

const EXT_ID = 'theater-favorites';
const API_BASE = '/api/plugins/theater-favorites';
const SETTINGS_KEY = 'theater-favorites-settings-v1';
const ICON_SRC = '/scripts/extensions/third-party/theater-favorites/assets/theater-play.png';

const DEFAULT_SETTINGS = {
    tagNames: ['snow'],
    detailsKeywords: ['小剧场', '番外', '剧场', 'side story'],
    loreFrameEnabled: true,
};

const state = {
    initialized: false,
    open: false,
    settings: loadSettings(),
    observer: null,
    scanTimer: 0,
    loreFrameScanTimer: 0,
    page: 1,
    pageSize: 20,
    total: 0,
    items: [],
    selectedId: '',
    detailLoadingId: '',
    backendOk: false,
    savedCandidateIds: new Set(),
    savedSignatures: new Set(),
    savedSignaturesLoaded: false,
    savedSignaturesLoading: null,
    filters: { search: '', character: '', chat: '', source: '', tag: '' },
    filterOptions: { characters: [], chats: [], sources: [], tags: [] },
};

function htmlEscape(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function attrEscape(value) {
    return htmlEscape(value).replaceAll('`', '&#96;');
}

function loadSettings() {
    try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function notify(message, kind = 'info') {
    const toastrApi = globalThis.toastr;
    if (!toastrApi) return;
    if (kind === 'success') toastrApi.success(message);
    else if (kind === 'error') toastrApi.error(message);
    else toastrApi.info(message);
}

async function api(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
            ...getRequestHeaders(),
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
        throw new Error(data.error || `${response.status} ${response.statusText || ''}`.trim());
    }
    return data;
}

function splitList(text) {
    return String(text || '')
        .split(/[\n,，、\s]+/)
        .map(item => item.trim().replace(/^<|>$/g, ''))
        .filter(Boolean);
}

function getMessageIdFromElement(element) {
    const message = element.closest?.('.mes');
    const raw = message?.getAttribute?.('mesid');
    const value = Number(raw);
    return Number.isInteger(value) ? value : null;
}

function getRawMessage(messageId, root) {
    if (messageId !== null && chat?.[messageId]?.mes) return String(chat[messageId].mes || '');
    return root?.innerText || root?.textContent || '';
}

function getCurrentCharacter() {
    const character = characters?.[this_chid] || {};
    return {
        id: this_chid ?? null,
        name: character.name || '',
        avatar: character.avatar || null,
    };
}

function getChatName() {
    return getCurrentChatId?.() || '';
}

function shortText(text, limit = 64) {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    if (cleaned.length <= limit) return cleaned;
    return `${cleaned.slice(0, limit)}...`;
}

function titleFromCandidate(candidate) {
    if (candidate.title) return shortText(candidate.title, 80);
    if (candidate.type === 'details-text' && candidate.detailsSummary) return candidate.detailsSummary;
    return shortText(candidate.plainText || candidate.rawSource || '未命名小剧场', 28) || '未命名小剧场';
}

function makeCandidateId(type, messageId, index, marker) {
    return `${EXT_ID}-${type}-${messageId ?? 'x'}-${index}-${String(marker || '').replace(/[^\w-]+/g, '-').slice(0, 28)}`;
}

function extractTagCandidates(messageElement, rawMessage, messageId) {
    const candidates = [];
    const tagNames = state.settings.tagNames.map(tag => tag.toLowerCase());

    tagNames.forEach(tag => {
        const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
        const matches = [...String(rawMessage || '').matchAll(pattern)];
        matches.forEach((match, index) => {
            const rawSource = match[0];
            const inner = rawSource
                .replace(new RegExp(`^<${tag}\\b[^>]*>`, 'i'), '')
                .replace(new RegExp(`<\\/${tag}>$`, 'i'), '');
            const rendered = findRenderedSnapshot(messageElement, tag, index, inner);
            const cleanRendered = cloneWithoutFavoriteButtons(rendered);
            candidates.push({
                id: makeCandidateId('tag', messageId, index, tag),
                type: /<[^>]+>/.test(inner) ? 'tag-html' : 'tag-regex',
                sourceTag: tag,
                rawSource,
                renderedHtml: cleanRendered?.outerHTML || inner,
                plainText: cleanRendered?.innerText || stripTags(inner),
                anchor: rendered || messageElement,
                messageId,
            });
        });

        messageElement.querySelectorAll(tag).forEach((element, index) => {
            const rawSource = element.outerHTML || '';
            const candidateId = makeCandidateId('tagdom', messageId, index, tag);
            if (candidates.some(item => item.rawSource === rawSource || item.id === candidateId)) return;
            const cleanElement = cloneWithoutFavoriteButtons(element);
            candidates.push({
                id: candidateId,
                type: /<[^>]+>/.test(element.innerHTML || '') ? 'tag-html' : 'tag-regex',
                sourceTag: tag,
                rawSource,
                renderedHtml: cleanElement?.outerHTML || element.outerHTML,
                plainText: cleanElement?.innerText || cleanElement?.textContent || element.innerText || element.textContent || '',
                anchor: element,
                messageId,
            });
        });
    });

    return candidates;
}

function findRenderedSnapshot(messageElement, tag, index, inner = '') {
    const direct = messageElement.querySelectorAll(tag)[index];
    if (direct) return direct;
    const messageText = messageElement.querySelector('.mes_text');
    if (!messageText) return messageElement;

    const likelyNodes = [...messageText.querySelectorAll([
        'details',
        'section',
        'article',
        'blockquote',
        'table',
        '[data-theater]',
        '[class*="snow" i]',
        '[class*="theater" i]',
        '[class*="profile" i]',
        '[class*="card" i]',
        '[class*="scene" i]',
    ].join(', '))];

    const snippets = buildSearchSnippets(inner);
    const bySnippet = findElementBySnippets(messageText, likelyNodes, snippets);
    if (bySnippet) return bySnippet;

    if (likelyNodes[index]) return likelyNodes[index];

    const topLevel = [...messageText.children].filter(element => element.textContent?.trim());
    return topLevel[index] || messageText;
}

function stripTags(html) {
    const div = document.createElement('div');
    div.innerHTML = String(html || '');
    return div.innerText || div.textContent || '';
}

function stripOuterSourceTag(rawSource, sourceTag) {
    let source = String(rawSource || '').trim();
    const tag = String(sourceTag || '').trim();
    if (!tag) return source;
    source = source
        .replace(new RegExp(`^<${tag}\\b[^>]*>`, 'i'), '')
        .replace(new RegExp(`<\\/${tag}>$`, 'i'), '')
        .trim();
    return source;
}

function extractStandaloneHtml(source) {
    const text = String(source || '').trim();
    const docMatch = text.match(/(?:<!doctype html[^>]*>\s*)?<html[\s\S]*<\/html>/i);
    if (docMatch) return docMatch[0];
    return '';
}

function extractHtmlCodeBlock(source) {
    const text = String(source || '');
    const fenced = [...text.matchAll(/```(?:html)?\s*([\s\S]*?)```/gi)]
        .map(match => match[1].trim())
        .find(block => /<(?:!doctype|html|style|script|body|div)\b/i.test(block));
    if (fenced) return fenced;

    const template = document.createElement('template');
    template.innerHTML = text;
    const code = [...template.content.querySelectorAll('pre code, code.custom-html, code.custom-language-html')]
        .map(node => node.textContent?.trim() || '')
        .find(block => /<(?:!doctype|html|style|script|body|div)\b/i.test(block));
    return code || '';
}

function extractRunnableHtml(source) {
    const text = String(source || '').trim();
    const codeBlock = extractHtmlCodeBlock(text);
    const candidate = codeBlock || text;
    const complete = extractStandaloneHtml(candidate);
    if (complete) return complete;

    const start = candidate.search(/<!doctype\s+html|<html\b/i);
    return start >= 0 ? candidate.slice(start) : '';
}

function bestRunnableHtml(item, rawBody) {
    return [rawBody, item.renderedHtml || '', item.plainText || '']
        .map(extractRunnableHtml)
        .filter(Boolean)
        .sort((left, right) => {
            const score = value =>
                (/<\/html\s*>/i.test(value) ? 10000000 : 0)
                + (/<\/script\s*>/i.test(value) ? 1000000 : 0)
                + value.length;
            return score(right) - score(left);
        })[0] || '';
}

function addPreviewResizeBridge(html, token) {
    const transparentCanvas = '<style id="theater-favorites-canvas-reset">:where(html){color:#eee9df;color-scheme:dark;background-color:transparent}:where(body){background-color:transparent}</style>';
    const bridge = `<script>(function(){var queued=false;var send=function(){if(queued)return;queued=true;requestAnimationFrame(function(){queued=false;var body=document.body;var root=document.documentElement;var height=Math.max(root.scrollHeight,root.offsetHeight,body?body.scrollHeight:0,body?body.offsetHeight:0);parent.postMessage({type:'theater-favorites-resize',token:${JSON.stringify(token)},height:height},'*')})};addEventListener('load',send);addEventListener('resize',send);new MutationObserver(send).observe(document.documentElement,{subtree:true,childList:true,attributes:true});if(window.ResizeObserver){var observer=new ResizeObserver(send);observer.observe(document.documentElement);if(document.body)observer.observe(document.body)}setTimeout(send,100);setTimeout(send,600)})();<\/script>`;
    let documentHtml = /<head\b[^>]*>/i.test(html)
        ? html.replace(/<head\b[^>]*>/i, match => `${match}${transparentCanvas}`)
        : `${transparentCanvas}${html}`;
    return /<\/body\s*>/i.test(documentHtml)
        ? documentHtml.replace(/<\/body\s*>/i, `${bridge}</body>`)
        : `${documentHtml}${bridge}`;
}

function unwrapDetailsForPreview(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    template.content.querySelectorAll('details').forEach(details => {
        const fragment = document.createDocumentFragment();
        [...details.childNodes].forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE && node.tagName?.toLowerCase() === 'summary') return;
            fragment.append(node.cloneNode(true));
        });
        details.replaceWith(fragment);
    });
    return template.innerHTML;
}

function openDetailsForFrame(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    template.content.querySelectorAll('details').forEach(details => details.setAttribute('open', ''));
    return template.innerHTML;
}

function sanitizeInlinePreview(html) {
    const template = document.createElement('template');
    template.innerHTML = unwrapDetailsForPreview(html);
    template.content.querySelectorAll(`.${EXT_ID}-save, .${EXT_ID}-message-save, script, iframe, object, embed`).forEach(node => node.remove());
    template.content.querySelectorAll('*').forEach(node => {
        [...node.attributes].forEach(attribute => {
            if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
        });
    });
    return template.innerHTML;
}

function plainPreviewHtml(value) {
    const template = document.createElement('template');
    template.innerHTML = String(value || '');
    const text = template.content.textContent || '';
    return `<pre class="${EXT_ID}-plain-preview">${htmlEscape(text)}</pre>`;
}

function buildPreviewHtml(item) {
    const rawBody = stripOuterSourceTag(item.rawSource || '', item.sourceTag);
    const inlineBody = unwrapDetailsForPreview(rawBody);
    const token = `${item.id}-${Date.now()}`;
    const runnable = bestRunnableHtml(item, rawBody);
    if (runnable) {
        const documentHtml = addPreviewResizeBridge(openDetailsForFrame(runnable), token);
        return `<iframe class="${EXT_ID}-html-frame" data-resize-token="${attrEscape(token)}" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads" srcdoc="${attrEscape(documentHtml)}"></iframe>`;
    }

    if (inlineBody && /<(script|style|link|body|head|meta|button|input|select|textarea|canvas)\b/i.test(inlineBody)) {
        const documentHtml = addPreviewResizeBridge(inlineBody, token);
        return `<iframe class="${EXT_ID}-html-frame" data-resize-token="${attrEscape(token)}" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads" srcdoc="${attrEscape(documentHtml)}"></iframe>`;
    }

    if (inlineBody && /<\w+[\s>]/.test(inlineBody)) {
        return sanitizeInlinePreview(inlineBody);
    }

    if (inlineBody) {
        return plainPreviewHtml(inlineBody);
    }

    if (item.renderedHtml) {
        return /<\w+[\s>]/.test(item.renderedHtml)
            ? sanitizeInlinePreview(item.renderedHtml)
            : plainPreviewHtml(item.renderedHtml);
    }

    return plainPreviewHtml(item.plainText || '');
}

function handlePreviewResize(event) {
    const data = event.data;
    if (!data || data.type !== `${EXT_ID}-resize` || !data.token) return;
    const frame = [...document.querySelectorAll(`.${EXT_ID}-html-frame[data-resize-token]`)]
        .find(candidate => candidate.dataset.resizeToken === data.token && candidate.contentWindow === event.source);
    if (!frame) return;
    const minimum = window.matchMedia('(max-width: 760px)').matches ? 260 : 300;
    const maximum = 30000;
    const measured = Math.ceil(Number(data.height) || minimum);
    const nextHeight = Math.max(minimum, Math.min(maximum, measured));
    const currentHeight = Math.round(frame.getBoundingClientRect().height);
    if (Math.abs(currentHeight - nextHeight) > 1) frame.style.height = `${nextHeight}px`;
}

function normalizeForMatch(text) {
    return String(text || '')
        .replace(/\s+/g, '')
        .replace(/[^\p{L}\p{N}]/gu, '')
        .toLowerCase();
}

function favoriteSignature(value) {
    const bytes = new TextEncoder().encode(String(value || ''));
    const bitLength = bytes.length * 8;
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const buffer = new Uint8Array(paddedLength);
    buffer.set(bytes);
    buffer[bytes.length] = 0x80;
    const view = new DataView(buffer.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(paddedLength - 4, bitLength >>> 0);

    const words = new Uint32Array(64);
    const hash = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const constants = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const rotate = (word, bits) => (word >>> bits) | (word << (32 - bits));

    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
        for (let index = 16; index < 64; index += 1) {
            const s0 = rotate(words[index - 15], 7) ^ rotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
            const s1 = rotate(words[index - 2], 17) ^ rotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
            words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = hash;
        for (let index = 0; index < 64; index += 1) {
            const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
            const choice = (e & f) ^ (~e & g);
            const temp1 = (h + s1 + choice + constants[index] + words[index]) >>> 0;
            const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (s0 + majority) >>> 0;
            h = g; g = f; f = e; e = (d + temp1) >>> 0;
            d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
        }
        [a, b, c, d, e, f, g, h].forEach((word, index) => { hash[index] = (hash[index] + word) >>> 0; });
    }
    return `sha256:${[...hash].map(word => word.toString(16).padStart(8, '0')).join('')}`;
}

function candidateSignature(candidate) {
    return favoriteSignature(candidate.rawSource || candidate.renderedHtml || candidate.plainText || '');
}

function isCandidateSaved(candidate) {
    return state.savedCandidateIds.has(candidate.id) || state.savedSignatures.has(candidateSignature(candidate));
}

async function loadSavedSignatures({ force = false } = {}) {
    if (state.savedSignaturesLoading) return state.savedSignaturesLoading;
    if (state.savedSignaturesLoaded && !force) return;

    state.savedSignaturesLoading = (async () => {
        const signatures = new Set();
        let offset = 0;
        let total = 0;
        do {
            const data = await api(`/theaters?limit=100&offset=${offset}`);
            const theaters = data.theaters || [];
            total = Number(data.total || theaters.length);
            theaters.forEach(item => {
                const signature = item.signature || favoriteSignature(item.rawSource || item.plainText || item.renderedHtml || '');
                if (signature) signatures.add(signature);
            });
            offset += theaters.length;
            if (!theaters.length) break;
        } while (offset < total && offset < 1000);

        state.savedSignatures = signatures;
        state.savedSignaturesLoaded = true;
    })().finally(() => {
        state.savedSignaturesLoading = null;
    });

    return state.savedSignaturesLoading;
}

function buildSearchSnippets(html) {
    const plain = stripTags(html);
    const lines = plain
        .split(/\n+/)
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(line => normalizeForMatch(line).length >= 4);
    const chunks = [...lines, plain.replace(/\s+/g, ' ').trim()]
        .map(line => normalizeForMatch(line).slice(0, 28))
        .filter(snippet => snippet.length >= 4);
    return [...new Set(chunks)].slice(0, 8);
}

function findElementBySnippets(messageText, likelyNodes, snippets) {
    if (!snippets.length) return null;

    for (const node of likelyNodes) {
        const nodeText = normalizeForMatch(node.innerText || node.textContent || '');
        if (snippets.some(snippet => nodeText.includes(snippet))) return node;
    }

    const walker = document.createTreeWalker(messageText, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode) {
        const nodeText = normalizeForMatch(textNode.nodeValue || '');
        if (snippets.some(snippet => nodeText.includes(snippet))) {
            return closestRenderedBlock(textNode.parentElement, messageText);
        }
        textNode = walker.nextNode();
    }

    return null;
}

function closestRenderedBlock(element, messageText) {
    if (!element) return messageText;
    const namedBlock = element.closest('details, section, article, blockquote, table, [data-theater], [class*="snow" i], [class*="theater" i], [class*="profile" i], [class*="card" i], [class*="scene" i]');
    if (namedBlock && messageText.contains(namedBlock)) return namedBlock;

    let current = element;
    let topChild = element;
    while (current && current.parentElement && current.parentElement !== messageText) {
        current = current.parentElement;
        topChild = current;
    }
    return messageText.contains(topChild) ? topChild : messageText;
}

function cloneWithoutFavoriteButtons(element) {
    if (!element) return null;
    const clone = element.cloneNode(true);
    clone.querySelectorAll?.(`.${EXT_ID}-save, .${EXT_ID}-message-save`).forEach(button => button.remove());
    return clone;
}

function detailsMatches(details) {
    const summaryElement = details.querySelector('summary');
    const summary = summaryElement?.innerText || summaryElement?.textContent || '';
    return state.settings.detailsKeywords.some(keyword => summary.toLowerCase().includes(keyword.toLowerCase()));
}

function extractDetailsCandidates(messageElement, rawMessage, messageId) {
    const messageText = messageElement.querySelector('.mes_text') || messageElement;
    const template = document.createElement('template');
    template.innerHTML = String(rawMessage || '');
    const detailsElements = [
        ...messageText.querySelectorAll('details'),
        ...template.content.querySelectorAll('details'),
    ];
    return detailsElements
        .filter(detailsMatches)
        .map((details, index) => {
            const summary = details.querySelector('summary')?.innerText || '';
            const cleanDetails = cloneWithoutFavoriteButtons(details);
            const nestedDocument = details.ownerDocument !== document;
            return {
                id: makeCandidateId('details', messageId, index, summary),
                type: 'details-text',
                sourceTag: '',
                detailsSummary: summary,
                rawSource: cleanDetails?.outerHTML || details.outerHTML || '',
                renderedHtml: cleanDetails?.outerHTML || details.outerHTML || '',
                plainText: cleanDetails?.textContent || details.textContent || '',
                anchor: nestedDocument ? messageText : details,
                messageId,
            };
        });
}

function getCandidatesForMessage(messageElement) {
    const messageId = getMessageIdFromElement(messageElement);
    const rawMessage = getRawMessage(messageId, messageElement);
    return dedupeCandidates([
        ...extractTagCandidates(messageElement, rawMessage, messageId),
        ...extractDetailsCandidates(messageElement, rawMessage, messageId),
    ]);
}

function dedupeCandidates(candidates) {
    const seen = new Set();
    return candidates.filter(candidate => {
        const body = normalizeForMatch(candidate.plainText || candidate.rawSource).slice(0, 80);
        const key = `${candidate.messageId}:${body}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function getMessageButtonAnchor(messageElement) {
    return messageElement.querySelector('.mes_text') || messageElement.querySelector('.mes_block') || messageElement;
}

function updateMessageFavoriteButton(button, candidates) {
    const pendingCount = candidates.filter(candidate => !isCandidateSaved(candidate)).length;
    const totalCount = candidates.length;
    button.disabled = pendingCount === 0;
    button.title = pendingCount
        ? `收藏这条消息里的 ${totalCount} 个小剧场`
        : '这条消息里的小剧场已收藏';
    button.innerHTML = pendingCount > 1
        ? `<i class="fa-solid fa-star"></i><span>${pendingCount}</span>`
        : '<i class="fa-solid fa-star"></i><span>收藏</span>';
}

function addMessageFavoriteButton(messageElement, candidates) {
    const anchor = getMessageButtonAnchor(messageElement);
    if (!anchor) return;
    if (!candidates.length) {
        anchor.querySelector?.(`:scope > .${EXT_ID}-message-save`)?.remove();
        return;
    }

    anchor.classList?.add?.(`${EXT_ID}-anchor`);
    let button = anchor.querySelector?.(`:scope > .${EXT_ID}-message-save`);
    if (!button) {
        button = document.createElement('button');
        button.className = `${EXT_ID}-message-save`;
        button.type = 'button';
        anchor.append(button);
    }

    updateMessageFavoriteButton(button, candidates);
    button.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        saveMessageCandidates(candidates, button).catch(error => notify(`收藏失败：${error.message}`, 'error'));
    };
}

function isUsefulIndividualAnchor(messageElement, candidate) {
    const messageText = messageElement.querySelector('.mes_text');
    return Boolean(candidate.anchor && candidate.anchor !== messageElement && candidate.anchor !== messageText);
}

function addCandidateFavoriteButton(candidate, slot = 0) {
    const anchor = candidate.anchor;
    if (!anchor) return;
    anchor.classList?.add?.(`${EXT_ID}-anchor`);

    let button = anchor.querySelector?.(`:scope > .${EXT_ID}-save[data-theater-favorite-id="${CSS.escape(candidate.id)}"]`);
    if (!button) {
        button = document.createElement('button');
        button.className = `${EXT_ID}-save`;
        button.type = 'button';
        button.dataset.theaterFavoriteId = candidate.id;
        anchor.append(button);
    }

    const saved = isCandidateSaved(candidate);
    button.disabled = saved;
    button.title = saved ? '这个小剧场已收藏' : '收藏这个小剧场';
    button.innerHTML = saved
        ? '<i class="fa-solid fa-check"></i><span>已收</span>'
        : '<i class="fa-solid fa-star"></i><span>收藏</span>';
    button.style.top = `${6 + slot * 34}px`;
    button.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        saveCandidate(candidate).then(() => addCandidateFavoriteButton(candidate, slot)).catch(error => notify(`收藏失败：${error.message}`, 'error'));
    };
}

function getLoreFrameCandidate(source) {
    const html = String(source?.value ?? source ?? '').trim();
    if (!/^\s*(?:<!doctype\s+html[^>]*>\s*)?<html\b/i.test(html)) return null;
    const documentHtml = new DOMParser().parseFromString(html, 'text/html');
    const title = documentHtml.querySelector('title')?.textContent?.trim()
        || documentHtml.querySelector('h1, h2, header')?.textContent?.trim()
        || '拟界文库小剧场';
    return {
        id: `${EXT_ID}-loreframe-${favoriteSignature(html).slice(0, 32)}`,
        type: 'loreframe-html',
        sourceTag: '拟界文库',
        title,
        rawSource: html,
        renderedHtml: html,
        plainText: documentHtml.body?.innerText || documentHtml.body?.textContent || title,
        messageId: null,
    };
}

function getCurrentLoreFrameEntry() {
    const windows = [globalThis];
    getAccessibleFrameRecords().forEach(record => {
        const frameWindow = record.doc?.defaultView;
        if (frameWindow && !windows.includes(frameWindow)) windows.push(frameWindow);
    });
    const context = windows
        .map(frameWindow => frameWindow.SillyTavern?.getContext?.())
        .find(item => item?.chatMetadata?.['online-content-floating-window']);
    const data = context?.chatMetadata?.['online-content-floating-window'];
    if (!data || typeof data !== 'object') return null;

    const entries = Array.isArray(data.entries) ? data.entries : [];
    const entry = entries.find(item => String(item?.id) === String(data.active_entry_id))
        || entries.at(-1)
        || data.active_entry
        || null;
    if (!entry) return getLoreFrameCandidate(data.html || '');

    const variants = Array.isArray(entry.variants) ? entry.variants : [];
    const variant = variants.find(item => String(item?.id) === String(entry.active_variant_id))
        || variants.at(-1)
        || entry;
    const candidate = getLoreFrameCandidate(variant?.html || entry.html || data.html || '');
    if (!candidate) return null;

    candidate.title = String(variant?.title || entry.title || candidate.title || '拟界文库小剧场');
    candidate.messageId = entry.message_id ?? null;
    candidate.id = `${EXT_ID}-loreframe-${favoriteSignature(candidate.rawSource).slice(0, 32)}`;
    return candidate;
}

function getAccessibleFrameRecords(doc = document, offsetX = 0, offsetY = 0, seen = new Set()) {
    if (!doc || seen.has(doc)) return [];
    seen.add(doc);
    const records = [{ doc, frame: doc.defaultView?.frameElement || null, offsetX, offsetY }];
    doc.querySelectorAll('iframe').forEach(frame => {
        try {
            const child = frame.contentDocument;
            if (!child) return;
            const rect = frame.getBoundingClientRect();
            records.push(...getAccessibleFrameRecords(child, offsetX + rect.left, offsetY + rect.top, seen));
        } catch {
            // Tavern Helper may contain unrelated cross-origin frames.
        }
    });
    return records;
}

function findLoreFrameRecord() {
    for (const record of getAccessibleFrameRecords()) {
        const candidates = [
            record.doc.getElementById('online-content-floating-window-iframe'),
            ...record.doc.querySelectorAll('iframe[title="LoreFrame"], iframe[aria-label="LoreFrame"]'),
        ].filter(Boolean);
        for (const frame of candidates) {
            const rect = frame.getBoundingClientRect();
            const style = record.doc.defaultView?.getComputedStyle(frame);
            const panelOpen = rect.width >= 280
                && rect.height >= 240
                && style?.visibility !== 'hidden'
                && Number(style?.opacity || 0) > 0.1
                && style?.pointerEvents !== 'none';
            if (panelOpen) {
                return {
                    frame,
                    bounds: {
                        left: record.offsetX + rect.left,
                        top: record.offsetY + rect.top,
                        right: record.offsetX + rect.right,
                        bottom: record.offsetY + rect.bottom,
                        width: rect.width,
                        height: rect.height,
                    },
                };
            }
        }
    }
    return null;
}

function getLoreFramePreviewCandidate(loreFrameRecord) {
    const loreDocument = loreFrameRecord?.frame?.contentDocument;
    if (!loreDocument) return null;

    const sources = [];
    loreDocument.querySelectorAll('textarea').forEach(textarea => {
        const value = String(textarea.value || textarea.textContent || '').trim();
        if (value) sources.push({ value, priority: 3 });
    });
    loreDocument.querySelectorAll('iframe').forEach(frame => {
        const srcdoc = String(frame.srcdoc || '').trim();
        if (srcdoc) sources.push({ value: srcdoc, priority: 2 });
        try {
            const previewDocument = frame.contentDocument;
            if (previewDocument?.documentElement) {
                sources.push({
                    value: `<!doctype html>\n${previewDocument.documentElement.outerHTML}`,
                    priority: 1,
                });
            }
        } catch {
            // Ignore unrelated cross-origin frames.
        }
    });

    return sources
        .map(source => ({ ...source, candidate: getLoreFrameCandidate(source.value) }))
        .filter(source => source.candidate)
        .sort((left, right) => right.priority - left.priority || right.value.length - left.value.length)[0]
        ?.candidate || null;
}

function updateLoreFrameFavoriteButton(button, candidate) {
    const saved = isCandidateSaved(candidate);
    button.disabled = saved;
    button.innerHTML = saved
        ? '<span aria-hidden="true">✓</span><span class="theater-favorites-loreframe-label">已收藏</span>'
        : `<img src="${ICON_SRC}" alt=""><span class="theater-favorites-loreframe-label">收藏小剧场</span>`;
    const image = button.querySelector('img');
    if (image) {
        image.style.setProperty('width', '22px');
        image.style.setProperty('height', '22px');
        image.style.setProperty('object-fit', 'contain');
    }
    button.title = saved ? '这个拟界文库作品已经收藏' : '把当前完整 HTML 收藏到小剧场收藏夹';
    button.setAttribute('aria-label', button.title);
}

function addLoreFrameFavoriteButtons() {
    if (!state.settings.loreFrameEnabled) {
        document.querySelector(`#${EXT_ID}-loreframe-overlay-save`)?.remove();
        return;
    }
    const loreFrameRecord = findLoreFrameRecord();
    let button = document.querySelector(`#${EXT_ID}-loreframe-overlay-save`);
    if (!loreFrameRecord) {
        button?.remove();
        return;
    }

    const { bounds } = loreFrameRecord;
    if (!button) {
        button = document.createElement('button');
        button.id = `${EXT_ID}-loreframe-overlay-save`;
        button.className = `${EXT_ID}-loreframe-overlay-save`;
        button.type = 'button';
        document.body.append(button);
        button.disabled = false;
        button.innerHTML = `<img src="${ICON_SRC}" alt="">`;
        button.title = '收藏当前拟界文库小剧场到【小剧场收藏夹】';
        button.setAttribute('aria-label', button.title);
    }
    const buttonWidth = 40;
    const left = Math.min(
        window.innerWidth - buttonWidth - 8,
        Math.max(8, bounds.right - buttonWidth - 112),
    );
    button.style.left = `${Math.round(left)}px`;
    button.style.top = `${Math.max(8, Math.round(bounds.top + 18))}px`;
    button.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        const current = getCurrentLoreFrameEntry() || getLoreFramePreviewCandidate(findLoreFrameRecord());
        if (!current) return notify('没有读取到拟界文库当前小剧场，请先打开一条小剧场。', 'error');
        saveCandidate(current)
            .then(() => {
                button.innerHTML = '<i class="fa-solid fa-check"></i>';
                button.title = '当前小剧场已收藏';
                button.setAttribute('aria-label', button.title);
            })
            .catch(error => notify(`收藏失败：${error.message}`, 'error'));
    };
}

function addFavoriteButtons() {
    document.querySelectorAll('#chat .mes').forEach(messageElement => {
        const candidates = getCandidatesForMessage(messageElement);
        const anchorSlots = new WeakMap();
        const individualIds = new Set();

        candidates.forEach(candidate => {
            if (!isUsefulIndividualAnchor(messageElement, candidate)) return;
            const slot = anchorSlots.get(candidate.anchor) || 0;
            anchorSlots.set(candidate.anchor, slot + 1);
            individualIds.add(candidate.id);
            addCandidateFavoriteButton(candidate, slot);
        });

        const fallbackCandidates = candidates.filter(candidate => !individualIds.has(candidate.id));
        addMessageFavoriteButton(messageElement, fallbackCandidates);
    });
    addLoreFrameFavoriteButtons();
}

function scheduleScan() {
    if (state.scanTimer) return;
    state.scanTimer = window.setTimeout(() => {
        state.scanTimer = 0;
        addLauncher();
        addMenuEntry();
        addFavoriteButtons();
    }, 250);
}

function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(scheduleScan);
    state.observer.observe(document.body, { childList: true, subtree: true });
    addFavoriteButtons();
    if (!state.loreFrameScanTimer) {
        state.loreFrameScanTimer = window.setInterval(addLoreFrameFavoriteButtons, 1500);
    }
}

async function saveCandidate(candidate) {
    const payload = {
        sourceType: candidate.type,
        sourceTag: candidate.sourceTag || '',
        detailsSummary: candidate.detailsSummary || '',
        rawSource: candidate.rawSource || '',
        renderedHtml: candidate.renderedHtml || '',
        plainText: candidate.plainText || '',
        title: titleFromCandidate(candidate),
        chat: {
            name: getChatName(),
            messageId: candidate.messageId,
        },
        character: getCurrentCharacter(),
        tags: [],
    };
    await api('/theaters', {
        method: 'POST',
        body: JSON.stringify(payload),
    });
    state.savedCandidateIds.add(candidate.id);
    state.savedSignatures.add(candidateSignature(candidate));
    notify('已收藏小剧场。', 'success');
    if (state.open) loadTheaters().catch(() => {});
}

async function saveMessageCandidates(candidates, button) {
    const pending = candidates.filter(candidate => !isCandidateSaved(candidate));
    if (!pending.length) {
        notify('这条消息里的小剧场已经收藏过了。');
        return;
    }

    for (const candidate of pending) {
        const payload = {
            sourceType: candidate.type,
            sourceTag: candidate.sourceTag || '',
            detailsSummary: candidate.detailsSummary || '',
            rawSource: candidate.rawSource || '',
            renderedHtml: candidate.renderedHtml || '',
            plainText: candidate.plainText || '',
            title: titleFromCandidate(candidate),
            chat: {
                name: getChatName(),
                messageId: candidate.messageId,
            },
            character: getCurrentCharacter(),
            tags: [],
        };
        await api('/theaters', {
            method: 'POST',
            body: JSON.stringify(payload),
        });
        state.savedCandidateIds.add(candidate.id);
        state.savedSignatures.add(candidateSignature(candidate));
    }

    updateMessageFavoriteButton(button, candidates);
    notify(pending.length > 1 ? `已收藏 ${pending.length} 个小剧场。` : '已收藏小剧场。', 'success');
    if (state.open) loadTheaters().catch(() => {});
}

function buildPanel() {
    if (document.querySelector(`#${EXT_ID}-panel`)) return;
    const panel = document.createElement('section');
    panel.id = `${EXT_ID}-panel`;
    panel.setAttribute('aria-label', '小剧场收藏夹');
    panel.innerHTML = `
        <div class="${EXT_ID}-head">
            <div class="${EXT_ID}-brand">
                <div class="${EXT_ID}-mark"><img class="${EXT_ID}-app-icon" src="${ICON_SRC}" alt=""></div>
                <div>
                    <div class="${EXT_ID}-title"><span>小剧场收藏夹 @KKM</span></div>
                    <div class="${EXT_ID}-sub">收藏、阅读和管理聊天里的小剧场。</div>
                </div>
            </div>
            <button id="${EXT_ID}-close" class="menu_button ${EXT_ID}-icon" type="button" title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="${EXT_ID}-toolbar">
            <div id="${EXT_ID}-status" class="${EXT_ID}-status">未连接</div>
            <div class="${EXT_ID}-actions">
                <button id="${EXT_ID}-refresh" class="menu_button ${EXT_ID}-button" type="button"><i class="fa-solid fa-rotate"></i><span>刷新</span></button>
                <button id="${EXT_ID}-settings-toggle" class="menu_button ${EXT_ID}-button" type="button"><i class="fa-solid fa-sliders"></i><span>设置</span></button>
            </div>
        </div>
        <div id="${EXT_ID}-settings" class="${EXT_ID}-settings" hidden>
            <div class="${EXT_ID}-settings-grid">
                <label>识别标签<input id="${EXT_ID}-tags" type="text" value="${htmlEscape(state.settings.tagNames.join(', '))}"></label>
                <label>details 关键词<input id="${EXT_ID}-keywords" type="text" value="${htmlEscape(state.settings.detailsKeywords.join(', '))}"></label>
            </div>
            <div class="${EXT_ID}-settings-row">
                <label class="${EXT_ID}-check"><input id="${EXT_ID}-loreframe-enabled" type="checkbox" ${state.settings.loreFrameEnabled ? 'checked' : ''}>兼容拟界文库（实验性）</label>
                <button id="${EXT_ID}-save-settings" class="menu_button ${EXT_ID}-button ${EXT_ID}-primary" type="button"><i class="fa-solid fa-check"></i><span>保存设置</span></button>
            </div>
            <div id="${EXT_ID}-health" class="${EXT_ID}-health"></div>
            <div class="${EXT_ID}-storage">
                <div>
                    <strong>本地存储</strong>
                    <span id="${EXT_ID}-storage-status">正在读取...</span>
                </div>
                <p id="${EXT_ID}-storage-warning" hidden></p>
                <div class="${EXT_ID}-storage-actions">
                    <div class="${EXT_ID}-storage-action">
                        <button id="${EXT_ID}-export-backup" class="menu_button ${EXT_ID}-button" type="button"><i class="fa-solid fa-file-arrow-down"></i><span>导出备份</span></button>
                        <small>完整保存正文、HTML、来源和标签，可用于恢复。</small>
                    </div>
                    <div class="${EXT_ID}-storage-action">
                        <button id="${EXT_ID}-import-backup" class="menu_button ${EXT_ID}-button" type="button"><i class="fa-solid fa-file-arrow-up"></i><span>导入备份</span></button>
                        <input id="${EXT_ID}-import-file" type="file" accept="application/json,.json" hidden>
                        <small>导入收藏夹 JSON，SHA-256 相同的条目会跳过。</small>
                    </div>
                    <div class="${EXT_ID}-storage-action">
                        <button id="${EXT_ID}-export-html" class="menu_button ${EXT_ID}-button" type="button"><i class="fa-solid fa-globe"></i><span>导出 HTML</span></button>
                        <small>生成浏览器可直接打开的阅读副本，不用于恢复。</small>
                    </div>
                    <div class="${EXT_ID}-storage-action">
                        <button id="${EXT_ID}-compact" class="menu_button ${EXT_ID}-button" type="button"><i class="fa-solid fa-broom"></i><span>整理空间</span></button>
                        <small>清理临时文件和没有目录记录的残留文件，不删除正常收藏。</small>
                    </div>
                    <div class="${EXT_ID}-storage-action">
                        <button id="${EXT_ID}-rebuild" class="menu_button ${EXT_ID}-button" type="button"><i class="fa-solid fa-arrows-rotate"></i><span>重建索引</span></button>
                        <small>目录损坏或收藏消失时，从 items 文件重新找回可读取的收藏。</small>
                    </div>
                    <div class="${EXT_ID}-storage-action danger">
                        <button id="${EXT_ID}-clear-all" class="menu_button ${EXT_ID}-button ${EXT_ID}-danger" type="button"><i class="fa-solid fa-trash-can"></i><span>清空全部收藏</span></button>
                        <small>永久删除收藏夹中的全部小剧场，不会删除 SillyTavern 聊天记录。</small>
                    </div>
                </div>
            </div>
        </div>
        <div class="${EXT_ID}-body">
            <div class="${EXT_ID}-rail-head">
                <span>收藏列表</span>
                <small>点开一条后，上一条会自动收起</small>
            </div>
            <div class="${EXT_ID}-filters">
                <input id="${EXT_ID}-search" type="search" placeholder="搜索标题、角色、聊天或标签">
                <select id="${EXT_ID}-character"><option value="">全部角色</option></select>
                <select id="${EXT_ID}-chat"><option value="">全部聊天</option></select>
                <select id="${EXT_ID}-source"><option value="">全部来源</option></select>
                <select id="${EXT_ID}-tag"><option value="">全部标签</option></select>
            </div>
            <div id="${EXT_ID}-list" class="${EXT_ID}-list"></div>
        </div>
        <div class="${EXT_ID}-pager">
            <button id="${EXT_ID}-prev" class="menu_button ${EXT_ID}-mini" type="button" title="上一页"><i class="fa-solid fa-chevron-left"></i></button>
            <span id="${EXT_ID}-page">1 / 1</span>
            <button id="${EXT_ID}-next" class="menu_button ${EXT_ID}-mini" type="button" title="下一页"><i class="fa-solid fa-chevron-right"></i></button>
        </div>
    `;
    document.body.append(panel);
    document.querySelector(`#${EXT_ID}-close`)?.addEventListener('click', closePanel);
    document.querySelector(`#${EXT_ID}-refresh`)?.addEventListener('click', () => loadTheaters().catch(showError));
    document.querySelector(`#${EXT_ID}-settings-toggle`)?.addEventListener('click', () => {
        const settings = document.querySelector(`#${EXT_ID}-settings`);
        const panel = document.querySelector(`#${EXT_ID}-panel`);
        if (settings) {
            settings.hidden = !settings.hidden;
            panel?.classList.toggle('settings-open', !settings.hidden);
            if (!settings.hidden) loadStorageStatus().catch(showError);
        }
    });
    document.querySelector(`#${EXT_ID}-save-settings`)?.addEventListener('click', savePanelSettings);
    document.querySelector(`#${EXT_ID}-compact`)?.addEventListener('click', () => compactStorage().catch(showError));
    document.querySelector(`#${EXT_ID}-rebuild`)?.addEventListener('click', () => rebuildStorageIndex().catch(showError));
    document.querySelector(`#${EXT_ID}-export-backup`)?.addEventListener('click', () => downloadExport('backup'));
    document.querySelector(`#${EXT_ID}-export-html`)?.addEventListener('click', () => downloadExport('html'));
    document.querySelector(`#${EXT_ID}-import-backup`)?.addEventListener('click', () => document.querySelector(`#${EXT_ID}-import-file`)?.click());
    document.querySelector(`#${EXT_ID}-import-file`)?.addEventListener('change', event => importBackup(event.target.files?.[0]).catch(showError));
    ['search', 'character', 'chat', 'source', 'tag'].forEach(name => {
        document.querySelector(`#${EXT_ID}-${name}`)?.addEventListener(name === 'search' ? 'input' : 'change', event => {
            state.filters[name] = event.target.value;
            state.page = 1;
            window.clearTimeout(state.filterTimer);
            state.filterTimer = window.setTimeout(() => loadTheaters().catch(showError), name === 'search' ? 250 : 0);
        });
    });
    document.querySelector(`#${EXT_ID}-clear-all`)?.addEventListener('click', () => clearStorage().catch(showError));
    document.querySelector(`#${EXT_ID}-prev`)?.addEventListener('click', () => changePage(-1));
    document.querySelector(`#${EXT_ID}-next`)?.addEventListener('click', () => changePage(1));
}

function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function renderHealthStatus() {
    const target = document.querySelector(`#${EXT_ID}-health`);
    if (!target) return;
    const loreFrameFound = Boolean(findLoreFrameRecord() || document.getElementById('online-content-floating-window-launcher'));
    target.innerHTML = `
        <span class="ok"><i class="fa-solid fa-check"></i> 前端已加载</span>
        <span class="${state.backendOk ? 'ok' : 'bad'}"><i class="fa-solid ${state.backendOk ? 'fa-check' : 'fa-xmark'}"></i> 后端${state.backendOk ? '已连接' : '未连接'}</span>
        <span><i class="fa-solid fa-book-open"></i> 拟界文库${state.settings.loreFrameEnabled ? (loreFrameFound ? '已检测到' : '未检测到') : '兼容已关闭'}</span>`;
}

async function downloadExport(kind) {
    const response = await fetch(`${API_BASE}/export/${kind}`, { headers: getRequestHeaders() });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '导出失败');
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const fileName = disposition.match(/filename="([^"]+)"/)?.[1] || `theater-favorites.${kind === 'html' ? 'html' : 'json'}`;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = fileName; link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function importBackup(file) {
    if (!file) return;
    if (!window.confirm(`导入备份“${file.name}”吗？已有相同内容会自动跳过。`)) return;
    const payload = JSON.parse(await file.text());
    const result = await api('/import', { method: 'POST', body: JSON.stringify(payload) });
    state.page = 1; state.savedSignaturesLoaded = false;
    await loadSavedSignatures({ force: true }); await loadTheaters(); await loadStorageStatus();
    notify(`已导入 ${result.imported} 条，跳过 ${result.skipped} 条重复收藏。`, 'success');
}

function renderStorageStatus(data) {
    const status = document.querySelector(`#${EXT_ID}-storage-status`);
    const warning = document.querySelector(`#${EXT_ID}-storage-warning`);
    if (status) status.textContent = `${formatBytes(data.bytes)} · ${data.total || 0} 条收藏${data.deleted ? ` · ${data.deleted} 条待整理` : ''}`;
    if (!warning) return;
    const bytes = Number(data.bytes) || 0;
    warning.hidden = bytes < 50 * 1024 ** 2;
    warning.classList.toggle('strong', bytes >= 200 * 1024 ** 2);
    warning.textContent = bytes >= 200 * 1024 ** 2
        ? '收藏文件已经较大。内容仍会完整保存，建议删除不需要的收藏后整理空间。'
        : '收藏文件超过 50 MB。内容仍会完整保存，可按需整理空间。';
}

async function loadStorageStatus() {
    const data = await api('/storage');
    state.backendOk = true;
    renderStorageStatus(data);
    renderHealthStatus();
}

async function compactStorage() {
    const data = await api('/storage/compact', { method: 'POST' });
    renderStorageStatus(data);
    notify('本地收藏文件已整理。', 'success');
    await loadTheaters();
}

async function rebuildStorageIndex() {
    if (!window.confirm('从本地 items 文件重新建立收藏目录吗？现有小剧场文件不会被删除。')) return;
    const data = await api('/storage/rebuild', { method: 'POST' });
    state.page = 1;
    state.selectedId = '';
    state.savedSignaturesLoaded = false;
    renderStorageStatus(data);
    await loadSavedSignatures({ force: true });
    await loadTheaters();
    notify(`索引已重建，找到 ${data.total || 0} 条收藏。`, 'success');
}

async function clearStorage() {
    if (!window.confirm('确定清空全部小剧场收藏吗？这不会删除聊天记录，但收藏文件无法恢复。')) return;
    if (!window.confirm('再次确认：删除小剧场收藏夹里的全部内容？')) return;
    const data = await api('/storage', { method: 'DELETE' });
    state.page = 1;
    state.selectedId = '';
    state.savedCandidateIds.clear();
    state.savedSignatures.clear();
    state.savedSignaturesLoaded = true;
    renderStorageStatus(data);
    await loadTheaters();
    addFavoriteButtons();
    notify('全部小剧场收藏已清空。', 'success');
}

function savePanelSettings() {
    state.settings.tagNames = splitList(document.querySelector(`#${EXT_ID}-tags`)?.value || 'snow');
    state.settings.detailsKeywords = splitList(document.querySelector(`#${EXT_ID}-keywords`)?.value || '');
    state.settings.loreFrameEnabled = Boolean(document.querySelector(`#${EXT_ID}-loreframe-enabled`)?.checked);
    saveSettings();
    addFavoriteButtons();
    renderHealthStatus();
    notify('设置已保存。', 'success');
}

function openPanel() {
    buildPanel();
    state.open = true;
    document.querySelector(`#${EXT_ID}-panel`)?.classList.add('open');
    loadTheaters().catch(showError);
}

function closePanel() {
    state.open = false;
    document.querySelector(`#${EXT_ID}-panel`)?.classList.remove('open');
}

function handleGlobalKeydown(event) {
    if (event.key === 'Escape' && state.open) closePanel();
}

function togglePanel() {
    if (state.open) closePanel();
    else openPanel();
}

function showError(error) {
    const status = document.querySelector(`#${EXT_ID}-status`);
    if (status) status.textContent = `后端不可用：${error.message}`;
    notify(`小剧场收藏夹后端不可用：${error.message}`, 'error');
}

async function loadTheaters() {
    const offset = (state.page - 1) * state.pageSize;
    const query = new URLSearchParams({ limit: state.pageSize, offset });
    Object.entries(state.filters).forEach(([key, value]) => { if (value) query.set(key, value); });
    const data = await api(`/theaters?${query}`);
    state.backendOk = true;
    state.items = data.theaters || [];
    state.total = data.total || 0;
    state.filterOptions = data.filters || state.filterOptions;
    state.items.forEach(item => {
        const signature = item.signature || favoriteSignature(item.rawSource || item.plainText || item.renderedHtml || '');
        if (signature) state.savedSignatures.add(signature);
    });
    state.savedSignaturesLoaded = true;
    if (!state.items.some(item => item.id === state.selectedId)) {
        state.selectedId = '';
    }
    renderList();
    renderFilterOptions();
    renderHealthStatus();
}

function renderFilterOptions() {
    const mapping = { character: 'characters', chat: 'chats', source: 'sources', tag: 'tags' };
    Object.entries(mapping).forEach(([id, key]) => {
        const select = document.querySelector(`#${EXT_ID}-${id}`);
        if (!select) return;
        const first = select.options[0]?.textContent || '全部';
        select.innerHTML = `<option value="">${htmlEscape(first)}</option>${(state.filterOptions[key] || []).map(value => `<option value="${attrEscape(value)}">${htmlEscape(value)}</option>`).join('')}`;
        select.value = state.filters[id] || '';
    });
}

function sourceLabel(item) {
    if (item.sourceType === 'loreframe-html') return '拟界文库';
    if (item.sourceType === 'details') return 'details';
    if (item.sourceTag) return item.sourceTag;
    if (/html/i.test(item.sourceType || '') || /<html|<!doctype/i.test(item.rawSource || '')) return 'HTML';
    return item.sourceType || '其他';
}

function renderList() {
    const list = document.querySelector(`#${EXT_ID}-list`);
    const status = document.querySelector(`#${EXT_ID}-status`);
    const page = document.querySelector(`#${EXT_ID}-page`);
    if (status) status.innerHTML = `<strong>${state.total}</strong><span>条收藏</span>`;
    if (page) page.textContent = `${state.page} / ${Math.max(1, Math.ceil(state.total / state.pageSize))}`;
    if (!list) return;
    if (!state.items.length) {
        list.innerHTML = '<div class="theater-favorites-empty">还没有收藏。聊天里的小剧场旁会出现收藏按钮。</div>';
        return;
    }
    const pageOffset = (state.page - 1) * state.pageSize;
    list.innerHTML = state.items.map((item, index) => `
        ${renderTheaterListItem(item, index, pageOffset)}
    `).join('');
    list.querySelectorAll(`.${EXT_ID}-item-toggle[data-id]`).forEach(button => {
        button.addEventListener('click', () => selectTheater(button.dataset.id || '').catch(showError));
    });
    list.querySelector(`#${EXT_ID}-read-prev`)?.addEventListener('click', () => selectNeighbor(-1));
    list.querySelector(`#${EXT_ID}-read-next`)?.addEventListener('click', () => selectNeighbor(1));
    list.querySelector(`#${EXT_ID}-delete`)?.addEventListener('click', () => deleteSelected().catch(showError));
    list.querySelector(`#${EXT_ID}-rename`)?.addEventListener('click', () => renameSelected().catch(showError));
    list.querySelector(`#${EXT_ID}-tag-add`)?.addEventListener('click', () => addSelectedTag().catch(showError));
    list.querySelector(`#${EXT_ID}-tag-input`)?.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            addSelectedTag().catch(showError);
        }
    });
    list.querySelectorAll(`.${EXT_ID}-tag-remove[data-tag]`).forEach(button => {
        button.addEventListener('click', () => removeSelectedTag(button.dataset.tag || '').catch(showError));
    });
}

function renderTheaterListItem(item, index, pageOffset) {
    const active = item.id === state.selectedId;
    const sourceLine = [item.character?.name, item.chat?.name, item.createdAt ? new Date(item.createdAt).toLocaleString() : ''].filter(Boolean).join(' · ');
    return `
        <article class="${EXT_ID}-entry ${active ? 'active' : ''}" data-id="${htmlEscape(item.id)}">
            <button class="${EXT_ID}-item-toggle" type="button" data-id="${htmlEscape(item.id)}" aria-expanded="${active ? 'true' : 'false'}">
                <span class="${EXT_ID}-item-no">${String(pageOffset + index + 1).padStart(2, '0')}</span>
                <span class="${EXT_ID}-item-main">
                    <strong>${htmlEscape(item.title || '未命名小剧场')}</strong>
                    <span><em class="${EXT_ID}-source-badge">${htmlEscape(sourceLabel(item))}</em> ${htmlEscape([item.character?.name, item.chat?.name, item.sizeBytes ? formatBytes(item.sizeBytes) : ''].filter(Boolean).join(' · ') || '未知来源')}</span>
                </span>
                <i class="fa-solid fa-chevron-down ${EXT_ID}-item-chevron"></i>
            </button>
            ${active ? renderExpandedTheater(item, sourceLine) : ''}
        </article>
    `;
}

function renderExpandedTheater(item, sourceLine) {
    if (!item.detailLoaded) {
        return `<div class="${EXT_ID}-expanded"><div class="${EXT_ID}-preview-label">正在读取小剧场...</div></div>`;
    }
    const selectedIndex = state.items.findIndex(entry => entry.id === state.selectedId);
    const absoluteIndex = (state.page - 1) * state.pageSize + selectedIndex + 1;
    const previewHtml = buildPreviewHtml(item);
    return `
        <div class="${EXT_ID}-expanded">
            <div class="${EXT_ID}-reader-actions">
                <button id="${EXT_ID}-read-prev" class="menu_button ${EXT_ID}-mini" type="button" title="上一条" ${selectedIndex <= 0 ? 'disabled' : ''}><i class="fa-solid fa-arrow-up"></i></button>
                <button id="${EXT_ID}-read-next" class="menu_button ${EXT_ID}-mini" type="button" title="下一条" ${selectedIndex >= state.items.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-arrow-down"></i></button>
                <button id="${EXT_ID}-delete" class="menu_button ${EXT_ID}-button ${EXT_ID}-danger" type="button"><i class="fa-solid fa-trash-can"></i><span>删除</span></button>
                <button id="${EXT_ID}-rename" class="menu_button ${EXT_ID}-button" type="button"><i class="fa-solid fa-pen"></i><span>重命名</span></button>
            </div>
            <div class="${EXT_ID}-source-line">${htmlEscape(sourceLine || `第 ${absoluteIndex} 条`)}</div>
            <div class="${EXT_ID}-tag-editor">
                <div class="${EXT_ID}-tag-row">
                    ${(item.tags || []).map(tag => `<span>${htmlEscape(tag)}<button class="${EXT_ID}-tag-remove" type="button" data-tag="${attrEscape(tag)}" title="删除标签" aria-label="删除标签 ${attrEscape(tag)}"><i class="fa-solid fa-xmark"></i></button></span>`).join('') || '<small>还没有标签</small>'}
                </div>
                <div class="${EXT_ID}-tag-add-row">
                    <input id="${EXT_ID}-tag-input" type="text" maxlength="60" placeholder="输入新标签">
                    <button id="${EXT_ID}-tag-add" class="menu_button ${EXT_ID}-button" type="button"><i class="fa-solid fa-plus"></i><span>添加</span></button>
                </div>
            </div>
            <div class="${EXT_ID}-preview-label">渲染预览</div>
            <div class="${EXT_ID}-preview">${previewHtml}</div>
            <details class="${EXT_ID}-raw">
                <summary>原文</summary>
                <pre>${htmlEscape(item.rawSource || item.plainText || '')}</pre>
            </details>
        </div>
    `;
}

async function saveSelectedMetadata(item, changes) {
    const data = await api(`/theaters/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(changes),
    });
    Object.assign(item, data.theater, { detailLoaded: true });
    renderList();
    await refreshFilterOptions();
}

async function refreshFilterOptions() {
    const data = await api('/theaters?limit=1&offset=0');
    state.filterOptions = data.filters || state.filterOptions;
    renderFilterOptions();
}

async function renameSelected() {
    const item = state.items.find(entry => entry.id === state.selectedId);
    if (!item) return;
    const title = window.prompt('收藏标题', item.title || '');
    if (title === null) return;
    await saveSelectedMetadata(item, { title: title.trim() || '未命名小剧场' });
    notify('标题已保存。', 'success');
}

async function addSelectedTag() {
    const item = state.items.find(entry => entry.id === state.selectedId);
    const input = document.querySelector(`#${EXT_ID}-tag-input`);
    const tag = String(input?.value || '').trim();
    if (!item || !tag) return;
    if ((item.tags || []).includes(tag)) return notify('这个标签已经存在。');
    if ((item.tags || []).length >= 20) return notify('每条收藏最多 20 个标签。', 'error');
    await saveSelectedMetadata(item, { tags: [...(item.tags || []), tag] });
    notify('标签已添加。', 'success');
}

async function removeSelectedTag(tag) {
    const item = state.items.find(entry => entry.id === state.selectedId);
    if (!item || !tag) return;
    await saveSelectedMetadata(item, { tags: (item.tags || []).filter(value => value !== tag) });
    notify('标签已删除。', 'success');
}

async function selectTheater(id) {
    if (!id) return;
    if (state.selectedId === id) {
        state.selectedId = '';
        state.detailLoadingId = '';
        renderList();
        return;
    }

    const item = state.items.find(entry => entry.id === id);
    state.selectedId = id;
    if (!item?.detailLoaded && Number(item?.sizeBytes || 0) >= 20 * 1024 ** 2) {
        const confirmed = window.confirm(`这条小剧场有 ${formatBytes(item.sizeBytes)}，加载和互动可能让手机或浏览器暂时卡顿。仍然打开吗？`);
        if (!confirmed) {
            state.selectedId = '';
            renderList();
            return;
        }
    }
    renderList();
    if (item?.detailLoaded) return;

    state.detailLoadingId = id;
    const data = await api(`/theaters/${encodeURIComponent(id)}`);
    const index = state.items.findIndex(entry => entry.id === id);
    if (index >= 0) state.items[index] = { ...state.items[index], ...data.theater, detailLoaded: true };
    if (state.detailLoadingId === id) state.detailLoadingId = '';
    renderList();
    if (state.selectedId === id) {
        window.setTimeout(() => document.querySelector(`.${EXT_ID}-entry.active`)?.scrollIntoView({ block: 'nearest' }), 0);
    }
}

function selectNeighbor(delta) {
    const currentIndex = state.items.findIndex(entry => entry.id === state.selectedId);
    const next = state.items[currentIndex + delta];
    if (!next) return;
    selectTheater(next.id).catch(showError);
}

async function deleteSelected() {
    if (!state.selectedId) return;
    await api(`/theaters/${encodeURIComponent(state.selectedId)}`, { method: 'DELETE' });
    state.selectedId = '';
    await loadSavedSignatures({ force: true }).catch(() => {});
    await loadTheaters();
}

function changePage(delta) {
    const maxPage = Math.max(1, Math.ceil(state.total / state.pageSize));
    state.page = Math.min(Math.max(1, state.page + delta), maxPage);
    loadTheaters().catch(showError);
}

function addLauncher() {
    const sendFormTarget = document.querySelector('#rightSendForm') || document.querySelector('#leftSendForm');
    const quickReplyTarget = document.querySelector('#qr--bar > .qr--buttons') || document.querySelector('#qr--bar');
    const target = quickReplyTarget || sendFormTarget;
    if (!target) {
        window.setTimeout(addLauncher, 800);
        return;
    }
    let button = document.querySelector(`#${EXT_ID}-open`);
    if (!button) {
        button = document.createElement('button');
        button.id = `${EXT_ID}-open`;
        button.className = `${EXT_ID}-qr qr--button`;
        button.type = 'button';
        button.title = '小剧场收藏夹';
        button.setAttribute('aria-label', '打开小剧场收藏夹');
        button.innerHTML = `<span class="${EXT_ID}-qr-icon" aria-hidden="true"></span>`;
        button.addEventListener('click', togglePanel);
    }
    button.classList.add(`${EXT_ID}-qr`, 'qr--button');
    button.classList.toggle(`${EXT_ID}-send-form-launcher`, target === sendFormTarget);
    if (button.parentElement !== target || target.firstElementChild !== button) target.prepend(button);
}

function addMenuEntry() {
    const menu = document.querySelector('#extensionsMenu');
    if (!menu || document.querySelector(`#${EXT_ID}-menu-entry`)) return;
    menu.insertAdjacentHTML('beforeend', `
        <div id="${EXT_ID}-menu-entry" class="list-group-item flex-container flexGap5 interactable" title="打开小剧场收藏夹" tabindex="0">
            <img class="${EXT_ID}-menu-icon" src="${ICON_SRC}" alt=""><span>小剧场收藏夹</span>
        </div>
    `);
    document.querySelector(`#${EXT_ID}-menu-entry`)?.addEventListener('click', openPanel);
}

function init() {
    if (state.initialized) return;
    state.initialized = true;
    buildPanel();
    startObserver();
    addLauncher();
    addMenuEntry();
    window.addEventListener('message', handlePreviewResize);
    document.addEventListener('keydown', handleGlobalKeydown);
    globalThis.TheaterFavoritesOpen = openPanel;
    loadSavedSignatures().then(() => addFavoriteButtons()).catch(() => {});
}

if (eventSource?.on && event_types?.APP_READY) {
    eventSource.on(event_types.APP_READY, init);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    window.setTimeout(init, 0);
}
