import {
    chat,
    characters,
    eventSource,
    event_types,
    getCurrentChatId,
    getRequestHeaders,
    messageFormatting,
    this_chid,
} from '../../../../script.js';

const EXT_ID = 'theater-favorites';
const API_BASE = '/api/plugins/theater-favorites';
const SETTINGS_KEY = 'theater-favorites-settings-v1';
const EXTENSION_PATH = '/scripts/extensions/third-party/theater-favorites';
const REMOTE_BASE = 'https://raw.githubusercontent.com/kongkongmie/sillytavern-theater-favorites/main';
const CHATU8_IMAGE_REQUEST_EVENT = 'generate-image-request';
const CHATU8_IMAGE_RESPONSE_EVENT = 'generate-image-response';

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
    chromeTimer: 0,
    pendingMessages: new Set(),
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
    updateChecked: false,
    updateHintChecked: false,
    updateAvailable: false,
    updateVersion: '',
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

function sortableDelay() {
    return window.matchMedia?.('(pointer: coarse)').matches ? 750 : 50;
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

function configuredTagPattern() {
    const tags = state.settings.tagNames
        .map(tag => String(tag || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .filter(Boolean);
    return tags.length ? new RegExp(`</?(?:${tags.join('|')})\\b[^>]*>`, 'gi') : null;
}

function looksLikeRunnableMarkup(value) {
    return /<(?:!doctype|html|head|body|style|script|link|meta|div|section|article|details|summary|table|ul|ol|li|p|br|span|img|button|input|select|textarea|canvas|svg)\b/i.test(String(value || ''));
}

function looksLikeMarkdownSource(value) {
    return /(^|\n)\s{0,3}#{1,6}\s+\S|(^|\n)\s{0,3}>\s+\S|(^|\n)\s*(?:[-*+]|\d+\.)\s+\S|(^|\n)\s*```|(?:\*\*|__)[\s\S]+?(?:\*\*|__)|(?:^|[^\w])(?:\*|_)[^\s*_][\s\S]*?[^\s*_](?:\*|_)(?:[^\w]|$)|~~[\s\S]+?~~|`[^`\n]+`|\[[^\]\n]+\]\([^)]+\)/m.test(String(value || ''));
}

function markdownSnapshotHtml(element, markdownSource = '') {
    if (!element || !looksLikeMarkdownSource(markdownSource)) return '';
    if (!element.querySelector?.([
        'strong',
        'b',
        'em',
        'i',
        'del',
        's',
        'code',
        'pre',
        'blockquote',
        'a[href]',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'ul',
        'ol',
        'li',
        'hr',
    ].join(','))) return '';
    return element.outerHTML || element.innerHTML || '';
}

function compactRenderedMarkdownSnapshot(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    const root = template.content;
    if (!root.querySelector('h1, h2, h3, h4, h5, h6, blockquote, ul, ol')) return '';
    root.querySelectorAll('details').forEach(details => details.setAttribute('open', ''));
    root.querySelectorAll('p').forEach(paragraph => {
        if (!paragraph.textContent?.trim() && !paragraph.querySelector('img, video, audio, button')) paragraph.remove();
    });
    root.querySelectorAll('details > br, snow > br, ccd > br').forEach(lineBreak => lineBreak.remove());
    root.querySelectorAll('br + br').forEach(lineBreak => lineBreak.remove());
    return sanitizeInlinePreview(template.innerHTML, { stripInlineStyles: true });
}

function renderedRegexSnapshotHtml(element, sourceTag = '') {
    if (!element) return '';
    const clean = cloneWithoutFavoriteButtons(element);
    if (!clean) return '';
    const tag = String(sourceTag || '').toLowerCase();
    const rootIsSourceTag = clean.tagName?.toLowerCase() === tag;
    const richNode = clean.querySelector?.([
        'style',
        '[style]',
        '[class]',
        'section',
        'article',
        'header',
        'main',
        'footer',
        'table',
        'button',
        'canvas',
        'svg',
    ].join(','));
    if (!richNode) return '';
    return rootIsSourceTag ? clean.innerHTML : clean.outerHTML;
}

function stripConfiguredTags(value) {
    const pattern = configuredTagPattern();
    return pattern ? String(value || '').replace(pattern, '') : String(value || '');
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
            const renderedText = cleanRendered?.innerText || cleanRendered?.textContent || '';
            const innerIsMarkup = looksLikeRunnableMarkup(inner);
            const renderedMarkdown = innerIsMarkup ? '' : markdownSnapshotHtml(cleanRendered, inner);
            const renderedRegex = innerIsMarkup || renderedMarkdown ? '' : renderedRegexSnapshotHtml(cleanRendered, tag);
            candidates.push({
                id: makeCandidateId('tag', messageId, index, tag),
                type: innerIsMarkup ? 'tag-html' : (renderedRegex ? 'tag-rendered' : (renderedMarkdown ? 'tag-markdown' : 'tag-regex')),
                sourceTag: tag,
                rawSource,
                renderedHtml: innerIsMarkup ? (cleanRendered?.outerHTML || inner) : (renderedRegex || renderedMarkdown),
                plainText: innerIsMarkup || renderedRegex || renderedMarkdown ? (renderedText || stripConfiguredTags(inner)) : stripConfiguredTags(inner),
                anchor: rendered || messageElement,
                messageId,
            });
        });

        messageElement.querySelectorAll(tag).forEach((element, index) => {
            const rawSource = element.outerHTML || '';
            const candidateId = makeCandidateId('tagdom', messageId, index, tag);
            if (candidates.some(item => item.rawSource === rawSource || item.id === candidateId || (item.sourceTag === tag && item.anchor === element))) return;
            const cleanElement = cloneWithoutFavoriteButtons(element);
            const elementHtml = element.innerHTML || '';
            const elementIsMarkup = looksLikeRunnableMarkup(elementHtml);
            candidates.push({
                id: candidateId,
                type: elementIsMarkup ? 'tag-html' : 'tag-regex',
                sourceTag: tag,
                rawSource,
                renderedHtml: elementIsMarkup ? (cleanElement?.outerHTML || element.outerHTML) : '',
                plainText: elementIsMarkup
                    ? (cleanElement?.innerText || cleanElement?.textContent || element.innerText || element.textContent || '')
                    : stripConfiguredTags(elementHtml),
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
    const transparentCanvas = '<style id="theater-favorites-canvas-reset">:where(html){color:#eee9df;color-scheme:dark;background-color:transparent;overflow-x:hidden}:where(body){background-color:transparent;transform-origin:top left}</style>';
    const bridge = `<script>(function(){var queued=false,lastHeight=0,lastScale=1,lastNaturalWidth=0;var fit=function(){var body=document.body;var root=document.documentElement;if(!body)return 1;var viewport=Math.max(1,root.clientWidth);var natural=Math.max(body.scrollWidth,body.offsetWidth);var scale=natural>viewport+8?viewport/natural:1;if(Math.abs(scale-lastScale)>.002||Math.abs(natural-lastNaturalWidth)>2){lastScale=scale;lastNaturalWidth=natural;if(scale<.998){body.style.transform='scale('+scale+')';body.style.width=natural+'px';root.style.overflowX='hidden'}else{body.style.transform='';body.style.width=''}}return scale};var send=function(){if(queued)return;queued=true;requestAnimationFrame(function(){queued=false;var body=document.body;var root=document.documentElement;var scale=fit();var naturalHeight=Math.max(root.scrollHeight,root.offsetHeight,body?body.scrollHeight:0,body?body.offsetHeight:0);var height=Math.ceil(naturalHeight*scale);if(Math.abs(height-lastHeight)<2)return;lastHeight=height;parent.postMessage({type:'theater-favorites-resize',token:${JSON.stringify(token)},height:height},'*')})};addEventListener('load',send);addEventListener('resize',send);new MutationObserver(send).observe(document.documentElement,{subtree:true,childList:true});if(window.ResizeObserver){var observer=new ResizeObserver(send);observer.observe(document.documentElement);if(document.body)observer.observe(document.body)}setTimeout(send,100);setTimeout(send,600)})();<\/script>`;
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

function isPersistentImageReference(value) {
    const source = String(value || '').trim();
    if (!source || /^(?:data|blob|javascript|file):/i.test(source)) return false;
    try {
        const url = new URL(source, window.location.href);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function referencedImagesFromSnapshot(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    return [...template.content.querySelectorAll('img[src]')]
        .map(image => ({
            src: image.getAttribute('src') || '',
            alt: image.getAttribute('alt') || '',
        }))
        .filter(image => isPersistentImageReference(image.src) && !image.src.includes('/theater-favorites/assets/theater-play.png'))
        .slice(0, 12);
}

function isChatu8ImageGenerationAvailable() {
    return typeof window.loadSilterTavernChatu8Settings === 'function'
        && typeof eventSource?.on === 'function'
        && typeof eventSource?.emit === 'function';
}

function normalizedImagePrompt(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildLiveChatu8ImageIndex() {
    const index = new Map();
    const roots = [document];
    document.querySelectorAll('iframe').forEach(frame => {
        try {
            if (frame.contentDocument) roots.push(frame.contentDocument);
        } catch {
            // Cross-origin frames are not eligible for same-page image reuse.
        }
    });
    for (const root of roots) {
        const requestSpans = new Map([...root.querySelectorAll('span[data-request-id]')]
            .map(span => [span.dataset.requestId || '', span]));
        const buttons = root.querySelectorAll('.st-chatu8-image-button[data-link], .image-tag-button[data-link]');
        for (const button of buttons) {
            const prompt = normalizedImagePrompt(button.dataset.link);
            if (!prompt || index.has(prompt)) continue;
            const requestId = button.dataset.requestId || '';
            const requestSpan = requestId ? requestSpans.get(requestId) : null;
            const image = requestSpan?.querySelector('img[src]')
                || button.nextElementSibling?.querySelector?.('img[src]')
                || button.closest('.st-chatu8-collapse-wrapper, p, div')?.querySelector?.('.st-chatu8-image-container img[src], img[alt="Generated Image"][src]');
            const src = image?.getAttribute('src') || '';
            if (src) index.set(prompt, { src, alt: image.getAttribute('alt') || '', transient: true });
        }
    }
    return index;
}

function replaceGenerationPromptBlocks(html, imageReferences = [], liveImageIndex = null) {
    let imageIndex = 0;
    return String(html || '')
        .replace(/<image\b[^>]*>([\s\S]*?)<imgthink\b[^>]*>[\s\S]*?<\/imgthink>([\s\S]*?)<\/image>/gi, (_match, labelSource, promptSource) => {
            const savedReference = imageReferences[imageIndex++];
            const prompt = String(promptSource || '').trim();
            const reference = savedReference || liveImageIndex?.get(normalizedImagePrompt(prompt));
            const label = stripTags(labelSource).trim() || reference?.alt || '';
            if (reference) {
                return `<figure class="${EXT_ID}-referenced-image${reference.transient ? ` ${EXT_ID}-live-image` : ''}">${label ? `<figcaption>${htmlEscape(label)}</figcaption>` : ''}<img src="${attrEscape(reference.src)}" alt="${attrEscape(reference.alt || label)}" loading="lazy">${reference.transient ? `<small class="${EXT_ID}-image-note">引用当前聊天中的智绘姬图片，未保存原图</small>` : ''}</figure>`;
            }
            if (!prompt || !isChatu8ImageGenerationAvailable()) return '';
            return `<figure class="${EXT_ID}-referenced-image ${EXT_ID}-chatu8-generation">${label ? `<figcaption>${htmlEscape(label)}</figcaption>` : ''}<button class="${EXT_ID}-chatu8-generate" type="button" data-image-prompt="${attrEscape(prompt)}" title="调用智绘姬当前生图配置，可能消耗额度"><i class="fa-solid fa-wand-magic-sparkles"></i><span>用智绘姬生成（可能消耗额度）</span></button><span class="${EXT_ID}-chatu8-status" aria-live="polite"></span></figure>`;
        })
        .replace(/<imgthink\b[^>]*>[\s\S]*?<\/imgthink>/gi, '');
}

function stripGenerationPromptBlocks(html) {
    return String(html || '')
        .replace(/<image\b[^>]*>[\s\S]*?<imgthink\b[^>]*>[\s\S]*?<\/imgthink>[\s\S]*?<\/image>/gi, '')
        .replace(/<imgthink\b[^>]*>[\s\S]*?<\/imgthink>/gi, '');
}

function sanitizeInlinePreview(html, options = {}) {
    const template = document.createElement('template');
    template.innerHTML = openDetailsForFrame(stripGenerationPromptBlocks(html));
    template.content.querySelectorAll(`.${EXT_ID}-save, .${EXT_ID}-message-save, script, iframe, object, embed`).forEach(node => node.remove());
    template.content.querySelectorAll('*').forEach(node => {
        [...node.attributes].forEach(attribute => {
            if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
            if (options.stripInlineStyles && attribute.name === 'style') node.removeAttribute(attribute.name);
        });
    });
    return template.innerHTML;
}

function structuredDetailsPreviewHtml(html) {
    const match = String(html || '').match(/<details\b[^>]*>([\s\S]*)<\/details>/i);
    if (!match) return '';
    const inner = match[1];
    const summaryMatch = inner.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i);
    const summary = stripTags(summaryMatch?.[1] || '').trim();
    const bodySource = summaryMatch ? inner.replace(summaryMatch[0], '') : inner;
    const bodyTemplate = document.createElement('template');
    bodyTemplate.innerHTML = sanitizeInlinePreview(bodySource);
    const textWalker = document.createTreeWalker(bodyTemplate.content, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (textWalker.nextNode()) textNodes.push(textWalker.currentNode);
    textNodes.forEach(node => {
        node.textContent = node.textContent.replace(/(?:[ \t]*\r?\n){2,}[ \t]*/g, '\n');
    });
    bodyTemplate.content.querySelectorAll(`figure.${EXT_ID}-referenced-image`).forEach(figure => {
        const previous = figure.previousSibling;
        const next = figure.nextSibling;
        if (previous?.nodeType === Node.TEXT_NODE) previous.textContent = previous.textContent.trimEnd();
        if (next?.nodeType === Node.TEXT_NODE) next.textContent = next.textContent.trimStart();
    });
    const body = bodyTemplate.innerHTML.trim();
    return `<section class="${EXT_ID}-structured-details"><div class="${EXT_ID}-structured-summary"><span aria-hidden="true">▼</span><span>${htmlEscape(summary)}</span></div><div class="${EXT_ID}-structured-details-body">${body}</div></section>`;
}

function plainPreviewHtml(value) {
    return `<pre class="${EXT_ID}-plain-preview">${htmlEscape(value)}</pre>`;
}

function markdownInlineHtml(value) {
    return htmlEscape(value)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_]+)__/g, '<strong>$1</strong>')
        .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
        .replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<em>$1</em>')
        .replace(/~~([^~]+)~~/g, '<del>$1</del>')
        .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

function stripMarkdownPreviewComments(value) {
    return String(value || '').replace(/<!--[^]*?-->/g, '');
}

function markdownSourcePreviewHtml(value) {
    const lines = stripMarkdownPreviewComments(stripConfiguredTags(value)).replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let paragraph = [];

    const flushParagraph = () => {
        if (!paragraph.length) return;
        blocks.push(`<p>${paragraph.map(markdownInlineHtml).join('<br>')}</p>`);
        paragraph = [];
    };

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] || '';
        const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
        if (heading) {
            flushParagraph();
            const level = Math.min(6, heading[1].length);
            blocks.push(`<h${level}>${markdownInlineHtml(heading[2].trim())}</h${level}>`);
            continue;
        }

        if (/^\s{0,3}>\s?/.test(line)) {
            flushParagraph();
            const quoteLines = [];
            while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index] || '')) {
                quoteLines.push((lines[index] || '').replace(/^\s{0,3}>\s?/, ''));
                index += 1;
            }
            index -= 1;
            const quoteHtml = quoteLines
                .join('\n')
                .split(/\n{2,}/)
                .map(part => part.split('\n').map(markdownInlineHtml).join('<br>'))
                .map(part => `<p>${part}</p>`)
                .join('');
            blocks.push(`<blockquote>${quoteHtml}</blockquote>`);
            continue;
        }

        if (!line.trim()) {
            flushParagraph();
            continue;
        }

        paragraph.push(line);
    }

    flushParagraph();
    return blocks.join('');
}

function sourceToPlainText(value) {
    const text = String(value || '');
    if (!looksLikeRunnableMarkup(text)) return stripConfiguredTags(text);
    const template = document.createElement('template');
    template.innerHTML = text;
    return template.content.textContent || text;
}

function editableSource(item) {
    return item.rawSource || item.renderedHtml || item.plainText || '';
}

function hasSelfContainedRendererMarkup(value) {
    return /<(?:style|script|link|canvas|svg)\b/i.test(String(value || ''))
        || /\bstyle\s*=/.test(String(value || ''));
}

function hasClassBasedRendererMarkup(value) {
    return /<\w+\b[^>]*\bclass\s*=/.test(String(value || ''));
}

function buildPreviewHtml(item) {
    const rawBody = stripOuterSourceTag(item.rawSource || '', item.sourceTag);
    const textOnlyBody = stripConfiguredTags(rawBody);
    if (item.sourceType === 'tag-rendered' && item.renderedHtml) {
        if (hasSelfContainedRendererMarkup(item.renderedHtml)) {
            const token = `${item.id}-${Date.now()}`;
            const documentHtml = addPreviewResizeBridge(item.renderedHtml, token);
            return `<iframe class="${EXT_ID}-html-frame" data-resize-token="${attrEscape(token)}" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads" srcdoc="${attrEscape(documentHtml)}"></iframe>`;
        }
        // Some display regexes only output class-based markup and keep their CSS
        // in SillyTavern's document. Keeping that snapshot in the host document
        // lets it inherit the same stylesheet; an isolated iframe would lose it.
        return `<div class="${EXT_ID}-regex-preview">${sanitizeInlinePreview(item.renderedHtml)}</div>`;
    }
    // Regex renderers such as TH-render often keep their complete runnable page
    // inside a rendered <code> snapshot. Restore that before treating an outer
    // <details> wrapper as ordinary structured text.
    const savedRunnable = bestRunnableHtml(item, rawBody);
    if (savedRunnable) {
        const token = `${item.id}-${Date.now()}`;
        const documentHtml = addPreviewResizeBridge(openDetailsForFrame(savedRunnable), token);
        return `<iframe class="${EXT_ID}-html-frame" data-resize-token="${attrEscape(token)}" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads" srcdoc="${attrEscape(documentHtml)}"></iframe>`;
    }
    const renderedMarkdownSnapshot = compactRenderedMarkdownSnapshot(item.renderedHtml || '');
    if (renderedMarkdownSnapshot) {
        return `<div class="${EXT_ID}-markdown-preview">${renderedMarkdownSnapshot}</div>`;
    }
    if (item.sourceTag && item.rawSource) {
        try {
            // A display regex often targets the complete <snow>...</snow>
            // block even when its contents also include <details> or other HTML.
            const formatted = messageFormatting(item.rawSource, item.character?.name || '', false, false, -1);
            const escapedTag = String(item.sourceTag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const stillHasSourceTag = new RegExp(`<\\/?${escapedTag}\\b`, 'i').test(formatted || '');
            const hasRendererMarkup = hasSelfContainedRendererMarkup(formatted);
            const hasClassRendererMarkup = hasClassBasedRendererMarkup(formatted);
            if (formatted && formatted !== item.rawSource && !stillHasSourceTag) {
                if (hasRendererMarkup) {
                    const token = `${item.id}-${Date.now()}`;
                    const documentHtml = addPreviewResizeBridge(formatted, token);
                    return `<iframe class="${EXT_ID}-html-frame" data-resize-token="${attrEscape(token)}" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads" srcdoc="${attrEscape(documentHtml)}"></iframe>`;
                }
                if (hasClassRendererMarkup) {
                    return `<div class="${EXT_ID}-regex-preview">${sanitizeInlinePreview(formatted)}</div>`;
                }
            }
        } catch (error) {
            console.warn('[Theater Favorites] Could not apply the current display regex.', error);
        }
    }
    if (item.sourceType === 'tag-markdown' && item.renderedHtml) {
        const sourcePreview = markdownSourcePreviewHtml(rawBody);
        const fallbackPreview = sanitizeInlinePreview(stripOuterSourceTag(item.renderedHtml, item.sourceTag), { stripInlineStyles: true });
        return `<div class="${EXT_ID}-markdown-preview">${sourcePreview || fallbackPreview}</div>`;
    }
    if (item.sourceType === 'tag-regex' && looksLikeMarkdownSource(rawBody)) {
        const sourcePreview = markdownSourcePreviewHtml(rawBody);
        if (sourcePreview) return `<div class="${EXT_ID}-markdown-preview">${sourcePreview}</div>`;
    }
    if ((item.sourceType === 'tag-regex' && !looksLikeRunnableMarkup(rawBody)) || item.sourceType === 'details-text') {
        return plainPreviewHtml(textOnlyBody || item.plainText || '');
    }
    const imageReferences = referencedImagesFromSnapshot(item.renderedHtml || '');
    const hasGenerationBlock = /<image\b[^>]*>[\s\S]*?<imgthink\b/i.test(rawBody);
    const liveImageIndex = hasGenerationBlock ? buildLiveChatu8ImageIndex() : null;
    const inlineBody = replaceGenerationPromptBlocks(rawBody, imageReferences, liveImageIndex);
    const token = `${item.id}-${Date.now()}`;

    // Nested text theaters must stay in the host document. Treating their saved
    // renderer snapshot as a runnable page can produce a blank iframe in Pake and
    // also prevents us from reusing images that 智绘姬 already restored in chat.
    if (inlineBody && /<details\b/i.test(inlineBody)) {
        const structured = structuredDetailsPreviewHtml(inlineBody);
        if (structured) return `<div class="${EXT_ID}-structured-text-preview">${structured}</div>`;
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
    const minimum = window.matchMedia('(max-width: 760px)').matches
        ? Math.min(520, Math.max(320, Math.round(window.innerHeight * 0.58)))
        : 300;
    const maximum = Math.max(minimum, Math.min(900, Math.round(window.innerHeight * 0.72)));
    const measured = Math.ceil(Number(data.height) || minimum);
    const nextHeight = Math.max(minimum, Math.min(maximum, measured));
    const currentHeight = Math.round(frame.getBoundingClientRect().height);
    if (Math.abs(currentHeight - nextHeight) > 1) frame.style.height = `${nextHeight}px`;
}

function generatePreviewImageWithChatu8(button) {
    const prompt = String(button?.dataset.imagePrompt || '').trim();
    const figure = button?.closest(`.${EXT_ID}-chatu8-generation`);
    const status = figure?.querySelector(`.${EXT_ID}-chatu8-status`);
    if (!prompt || !figure || !status) return;
    if (!isChatu8ImageGenerationAvailable()) {
        status.textContent = '智绘姬未加载，无法生成。';
        return;
    }

    const requestId = `${EXT_ID}-chatu8-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>智绘姬生成中…</span>';
    status.textContent = '图片只显示在本次预览，不会写入收藏。';

    let finished = false;
    const cleanup = () => {
        eventSource.removeListener?.(CHATU8_IMAGE_RESPONSE_EVENT, handleResponse);
    };
    const finishWithError = message => {
        if (finished) return;
        finished = true;
        cleanup();
        window.clearTimeout(timeout);
        button.disabled = false;
        button.innerHTML = originalHtml;
        status.textContent = message;
    };
    const handleResponse = response => {
        if (response?.id !== requestId || finished) return;
        const imageSource = String(response.imageData || response.imageUrl || '').trim();
        if (!response.success || !imageSource) {
            finishWithError(`生成失败：${response.error || '智绘姬没有返回图片'}`);
            return;
        }
        finished = true;
        cleanup();
        window.clearTimeout(timeout);
        let image = figure.querySelector('img');
        if (!image) {
            image = document.createElement('img');
            image.alt = figure.querySelector('figcaption')?.textContent || '智绘姬生成图片';
            figure.insertBefore(image, button);
        }
        image.src = imageSource;
        button.disabled = false;
        button.innerHTML = '<i class="fa-solid fa-rotate"></i><span>重新生成（可能消耗额度）</span>';
        status.textContent = '已生成；关闭或刷新预览后不会保留图片。';
    };
    const timeout = window.setTimeout(() => finishWithError('生成超时，请检查智绘姬任务或稍后重试。'), 5 * 60 * 1000);
    eventSource.on(CHATU8_IMAGE_RESPONSE_EVENT, handleResponse);
    Promise.resolve(eventSource.emit(CHATU8_IMAGE_REQUEST_EVENT, { id: requestId, prompt }))
        .catch(error => finishWithError(`无法调用智绘姬：${error.message}`));
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
    clone.querySelectorAll?.('img[src]').forEach(image => {
        if (!isPersistentImageReference(image.getAttribute('src'))) image.remove();
    });
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

function messageMightContainTheater(messageElement) {
    const messageId = getMessageIdFromElement(messageElement);
    const rawMessage = getRawMessage(messageId, messageElement);
    const tags = state.settings.tagNames
        .map(tag => String(tag || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .filter(Boolean);
    if (tags.length && new RegExp(`<(?:${tags.join('|')})\\b`, 'i').test(rawMessage)) return true;
    if (/<details\b/i.test(rawMessage)) return true;
    const selector = [...state.settings.tagNames, 'details']
        .map(tag => String(tag || '').trim())
        .filter(Boolean)
        .map(tag => CSS.escape(tag))
        .join(',');
    return Boolean(selector && messageElement.querySelector?.(selector));
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
    const markup = pendingCount > 1
        ? `<i class="fa-solid fa-star"></i><span>${pendingCount}</span>`
        : '<i class="fa-solid fa-star"></i><span>收藏</span>';
    if (button.innerHTML !== markup) button.innerHTML = markup;
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
    if (!button.dataset.theaterFavoritesBound) {
        button.dataset.theaterFavoritesBound = '1';
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            const latest = getCandidatesForMessage(messageElement);
            const fallback = latest.filter(candidate => !isUsefulIndividualAnchor(messageElement, candidate));
            saveMessageCandidates(fallback, button)
                .then(() => processMessage(messageElement))
                .catch(error => notify(`收藏失败：${error.message}`, 'error'));
        });
    }
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
    const markup = saved
        ? '<i class="fa-solid fa-check"></i><span>已收</span>'
        : '<i class="fa-solid fa-star"></i><span>收藏</span>';
    if (button.innerHTML !== markup) button.innerHTML = markup;
    const top = `${6 + slot * 34}px`;
    if (button.style.top !== top) button.style.top = top;
    if (!button.dataset.theaterFavoritesBound) {
        button.dataset.theaterFavoritesBound = '1';
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            const messageElement = anchor.closest('.mes');
            const latest = messageElement ? getCandidatesForMessage(messageElement) : [];
            const current = latest.find(item => item.id === button.dataset.theaterFavoriteId)
                || latest.find(item => item.anchor === anchor && item.sourceTag === candidate.sourceTag);
            if (!current) return notify('这条小剧场正在更新，请稍后再试。', 'error');
            saveCandidate(current)
                .then(() => processMessage(messageElement))
                .catch(error => notify(`收藏失败：${error.message}`, 'error'));
        });
    }
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
    const markup = saved
        ? '<span aria-hidden="true">✓</span><span class="theater-favorites-loreframe-label">已收藏</span>'
        : '<i class="fa-solid fa-masks-theater" aria-hidden="true"></i><span class="theater-favorites-loreframe-label">收藏小剧场</span>';
    if (button.innerHTML !== markup) button.innerHTML = markup;
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
        button.innerHTML = '<i class="fa-solid fa-masks-theater" aria-hidden="true"></i>';
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

function processMessage(messageElement) {
    if (!messageElement?.isConnected || !messageElement.matches?.('#chat .mes')) return;
    if (!messageMightContainTheater(messageElement)) {
        messageElement.querySelectorAll(`.${EXT_ID}-save, .${EXT_ID}-message-save`).forEach(button => button.remove());
        return;
    }
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

    messageElement.querySelectorAll(`.${EXT_ID}-save[data-theater-favorite-id]`).forEach(button => {
        if (!individualIds.has(button.dataset.theaterFavoriteId || '')) button.remove();
    });
    const fallbackCandidates = candidates.filter(candidate => !individualIds.has(candidate.id));
    addMessageFavoriteButton(messageElement, fallbackCandidates);
}

function addFavoriteButtons(messageElements = document.querySelectorAll('#chat .mes')) {
    [...messageElements].forEach(processMessage);
}

function scheduleLoreFrameRefresh() {
    if (!state.settings.loreFrameEnabled || state.loreFrameScanTimer) return;
    state.loreFrameScanTimer = window.setTimeout(() => {
        state.loreFrameScanTimer = 0;
        addLoreFrameFavoriteButtons();
    }, 300);
}

function handleLoreFrameInteraction(event) {
    if (!state.settings.loreFrameEnabled) return;
    if (document.querySelector(`#${EXT_ID}-loreframe-overlay-save`)) return scheduleLoreFrameRefresh();
    const trigger = event.target?.closest?.('button, [role="button"], [title], [aria-label]');
    const marker = [trigger?.textContent, trigger?.title, trigger?.getAttribute?.('aria-label')].filter(Boolean).join(' ');
    if (/拟界|lore\s*frame|online\s*content/i.test(marker)) scheduleLoreFrameRefresh();
}

function handleLoreFrameResize() {
    if (document.querySelector(`#${EXT_ID}-loreframe-overlay-save`)) scheduleLoreFrameRefresh();
}

function scheduleMessageScans(messages) {
    messages.forEach(message => state.pendingMessages.add(message));
    window.clearTimeout(state.scanTimer);
    state.scanTimer = window.setTimeout(() => {
        state.scanTimer = 0;
        const pending = [...state.pendingMessages];
        state.pendingMessages.clear();
        addFavoriteButtons(pending);
    }, 450);
}

function scheduleChromeRefresh() {
    if (state.chromeTimer) return;
    state.chromeTimer = window.setTimeout(() => {
        state.chromeTimer = 0;
        addLauncher();
        addMenuEntry();
    }, 120);
}

function extensionOwnsNode(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    const selector = [
        `#${EXT_ID}-panel`,
        `#${EXT_ID}-open`,
        `#${EXT_ID}-menu-entry`,
        `#${EXT_ID}-loreframe-overlay-save`,
        `.${EXT_ID}-save`,
        `.${EXT_ID}-message-save`,
        `.${EXT_ID}-reliable-icon`,
    ].join(',');
    return Boolean(element?.matches?.(selector) || element?.closest?.(selector));
}

function mutationIsExtensionOwned(mutation) {
    const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
    if (extensionOwnsNode(mutation.target)) return true;
    return changedNodes.length > 0 && changedNodes.every(extensionOwnsNode);
}

function mutationMessages(mutation) {
    const messages = new Set();
    const collect = (node, includeDescendants = false) => {
        const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        const closest = element?.closest?.('#chat .mes');
        if (closest) messages.add(closest);
        if (includeDescendants) {
            element?.querySelectorAll?.('.mes').forEach(message => {
                if (message.closest('#chat')) messages.add(message);
            });
        }
    };
    collect(mutation.target);
    mutation.addedNodes.forEach(node => collect(node, true));
    return messages;
}

function mutationTouchesChrome(mutation) {
    const selector = '#qr--bar, #rightSendForm, #leftSendForm, #extensionsMenu';
    const touches = (node, includeDescendants = false) => {
        const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        return Boolean(element?.matches?.(selector)
            || element?.closest?.(selector)
            || (includeDescendants && element?.querySelector?.(selector)));
    };
    return touches(mutation.target)
        || [...mutation.addedNodes, ...mutation.removedNodes].some(node => touches(node, true));
}

function handleDocumentMutations(mutations) {
    const messages = new Set();
    let refreshChrome = false;
    let refreshLoreFrame = false;
    mutations.forEach(mutation => {
        if (mutationIsExtensionOwned(mutation)) return;
        mutationMessages(mutation).forEach(message => messages.add(message));
        refreshChrome ||= mutationTouchesChrome(mutation);
        refreshLoreFrame ||= [...mutation.addedNodes].some(node => node.nodeName === 'IFRAME' || node.querySelector?.('iframe'));
    });
    if (messages.size) scheduleMessageScans(messages);
    if (refreshChrome) scheduleChromeRefresh();
    if (refreshLoreFrame) scheduleLoreFrameRefresh();
}

function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(handleDocumentMutations);
    state.observer.observe(document.body, { childList: true, subtree: true });
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

function compareVersions(left, right) {
    const a = String(left || '').replace(/^v/i, '').split('.').map(part => Number.parseInt(part, 10) || 0);
    const b = String(right || '').replace(/^v/i, '').split('.').map(part => Number.parseInt(part, 10) || 0);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
    }
    return 0;
}

async function fetchJson(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText || ''}`.trim());
    return response.json();
}

function setUpdateStatus(message, kind = '') {
    const target = document.querySelector(`#${EXT_ID}-update-status`);
    if (!target) return;
    target.className = `${EXT_ID}-update-status${kind ? ` ${kind}` : ''}`;
    target.textContent = message;
}

function renderUpdateHint(available, version = '') {
    const button = document.querySelector(`#${EXT_ID}-updates-toggle`);
    const label = button?.querySelector(`.${EXT_ID}-update-button-label`);
    const dot = button?.querySelector(`.${EXT_ID}-update-dot`);
    if (!button || !label || !dot) return;
    button.classList.toggle('has-update', available);
    label.textContent = available ? '有更新' : '更新';
    dot.hidden = !available;
    button.title = available ? `发现新版本 v${version}，点击查看更新内容` : '查看版本和更新内容';
    button.setAttribute('aria-label', button.title);
}

async function checkUpdateHintOnce() {
    if (state.updateHintChecked) return;
    state.updateHintChecked = true;
    try {
        const [localManifest, remoteManifest] = await Promise.all([
            fetchJson(`${EXTENSION_PATH}/manifest.json?time=${Date.now()}`),
            fetchJson(`${REMOTE_BASE}/manifest.json?time=${Date.now()}`),
        ]);
        const current = String(localManifest.version || '');
        const latest = String(remoteManifest.version || '');
        const available = compareVersions(latest, current) > 0;
        state.updateAvailable = available;
        state.updateVersion = latest;
        renderUpdateHint(available, latest);
    } catch {
        // A quiet hint check must never interrupt opening or using the favorites panel.
    }
}

function renderUpdateNotes(notes, latestVersion) {
    const target = document.querySelector(`#${EXT_ID}-update-notes`);
    if (!target) return;
    const releases = Array.isArray(notes?.releases) ? notes.releases : [];
    const selected = releases.find(release => String(release.version) === String(latestVersion)) || releases[0];
    if (!selected) {
        target.innerHTML = '<p>这个版本还没有填写更新内容。</p>';
        return;
    }
    const items = Array.isArray(selected.items) ? selected.items : [];
    target.innerHTML = `
        <article class="${EXT_ID}-release-card">
            <div class="${EXT_ID}-release-title"><strong>v${htmlEscape(selected.version)}</strong><span>${htmlEscape(selected.date || '')}</span></div>
            <h3>${htmlEscape(selected.title || '更新内容')}</h3>
            ${items.length ? `<ul>${items.map(item => `<li>${htmlEscape(item)}</li>`).join('')}</ul>` : '<p>这个版本还没有填写更新内容。</p>'}
        </article>`;
}

async function checkForExtensionUpdates() {
    const checkButton = document.querySelector(`#${EXT_ID}-check-update`);
    const installButton = document.querySelector(`#${EXT_ID}-install-update`);
    if (checkButton) checkButton.disabled = true;
    if (installButton) installButton.hidden = true;
    setUpdateStatus('正在检查 GitHub 上的新版本…');
    try {
        const [localManifest, remoteManifest, remoteNotes] = await Promise.all([
            fetchJson(`${EXTENSION_PATH}/manifest.json?time=${Date.now()}`),
            fetchJson(`${REMOTE_BASE}/manifest.json?time=${Date.now()}`),
            fetchJson(`${REMOTE_BASE}/updates.json?time=${Date.now()}`).catch(() => fetchJson(`${EXTENSION_PATH}/updates.json?time=${Date.now()}`)),
        ]);
        const current = String(localManifest.version || '未知');
        const latest = String(remoteManifest.version || remoteNotes.latest || '未知');
        state.updateChecked = true;
        state.updateVersion = latest;
        state.updateAvailable = compareVersions(latest, current) > 0;
        renderUpdateHint(state.updateAvailable, latest);
        document.querySelector(`#${EXT_ID}-current-version`)?.replaceChildren(document.createTextNode(`v${current}`));
        document.querySelector(`#${EXT_ID}-latest-version`)?.replaceChildren(document.createTextNode(`v${latest}`));
        renderUpdateNotes(remoteNotes, latest);
        if (state.updateAvailable) {
            setUpdateStatus(`发现新版本 v${latest}，请先阅读更新内容。`, 'available');
            if (installButton) installButton.hidden = false;
        } else {
            setUpdateStatus(compareVersions(current, latest) > 0 ? '当前安装的是开发版。' : '已经是最新版本。', 'current');
        }
    } catch (error) {
        setUpdateStatus(`检查失败：${error.message || error}。可稍后重试或前往 GitHub 手动更新。`, 'error');
    } finally {
        if (checkButton) checkButton.disabled = false;
    }
}

async function findExtensionInstall() {
    const entries = await fetch('/api/extensions/discover', { headers: getRequestHeaders() }).then(response => {
        if (!response.ok) throw new Error('无法读取扩展安装信息');
        return response.json();
    });
    const list = Array.isArray(entries) ? entries : entries.extensions || [];
    const match = list.find(entry => String(entry.name || '').replaceAll('\\', '/').split('/').pop() === EXT_ID);
    return { extensionName: match?.name || EXT_ID, global: match?.type === 'global' };
}

async function installExtensionUpdate() {
    if (!state.updateAvailable || !window.confirm(`更新到 v${state.updateVersion} 吗？更新完成后需要刷新页面。`)) return;
    const button = document.querySelector(`#${EXT_ID}-install-update`);
    if (button) button.disabled = true;
    setUpdateStatus('正在更新，请不要关闭 SillyTavern…');
    try {
        const install = await findExtensionInstall();
        const response = await fetch('/api/extensions/update', {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(install),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.error) throw new Error(result.error || `${response.status} ${response.statusText || ''}`.trim());
        state.updateAvailable = false;
        renderUpdateHint(false);
        if (button) button.hidden = true;
        setUpdateStatus('更新完成。点击“刷新页面”加载新版本。', 'current');
        const reload = document.querySelector(`#${EXT_ID}-reload-after-update`);
        if (reload) reload.hidden = false;
    } catch (error) {
        setUpdateStatus(`自动更新失败：${error.message || error}。如果是 ZIP 安装或 Git 权限问题，请使用下方链接手动更新。`, 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

function setPanelView(view = 'list') {
    const panel = document.querySelector(`#${EXT_ID}-panel`);
    if (!panel) return;
    const settings = document.querySelector(`#${EXT_ID}-settings`);
    const updates = document.querySelector(`#${EXT_ID}-updates`);
    panel.classList.toggle('settings-open', view === 'settings' || view === 'tags');
    panel.classList.toggle('tag-manager-open', view === 'tags');
    panel.classList.toggle('updates-open', view === 'updates');
    if (settings) settings.hidden = view !== 'settings' && view !== 'tags';
    if (updates) updates.hidden = view !== 'updates';
    const title = document.querySelector(`#${EXT_ID}-settings-title`);
    if (title) title.innerHTML = view === 'tags'
        ? '<i class="fa-solid fa-tags"></i> 标签管理'
        : '<i class="fa-solid fa-sliders"></i> 设置';
    ['tag-manager', 'updates', 'settings'].forEach(name => {
        const button = document.querySelector(`#${EXT_ID}-${name === 'tag-manager' ? 'tag-manager-toggle' : `${name}-toggle`}`);
        const active = view === (name === 'tag-manager' ? 'tags' : name);
        button?.classList.toggle('active', active);
        button?.setAttribute('aria-pressed', String(active));
    });
}

function toggleUpdatesPage() {
    const panel = document.querySelector(`#${EXT_ID}-panel`);
    const opening = !panel?.classList.contains('updates-open');
    setPanelView(opening ? 'updates' : 'list');
    if (opening) checkForExtensionUpdates().catch(showError);
}

function closeSubPage() {
    setPanelView('list');
}

async function toggleSettingsPage() {
    const panel = document.querySelector(`#${EXT_ID}-panel`);
    const opening = !panel?.classList.contains('settings-open') || panel.classList.contains('tag-manager-open');
    setPanelView(opening ? 'settings' : 'list');
    if (opening) {
        const settings = document.querySelector(`#${EXT_ID}-settings`);
        if (settings) settings.scrollTop = 0;
        await Promise.all([loadStorageStatus(), loadTagManager()]);
    }
}

function buildPanel() {
    if (document.querySelector(`#${EXT_ID}-panel`)) return;
    const panel = document.createElement('section');
    panel.id = `${EXT_ID}-panel`;
    panel.setAttribute('aria-label', '小剧场收藏夹');
    panel.innerHTML = `
        <div class="${EXT_ID}-head">
            <div class="${EXT_ID}-brand">
                <div class="${EXT_ID}-mark"><i class="fa-solid fa-masks-theater" aria-hidden="true"></i></div>
                <div>
                    <div class="${EXT_ID}-title"><span>小剧场收藏夹 <b class="${EXT_ID}-owner">@KKM</b></span></div>
                    <div class="${EXT_ID}-sub">收藏、阅读和管理聊天里的小剧场。</div>
                </div>
            </div>
            <button id="${EXT_ID}-close" class="menu_button ${EXT_ID}-icon" type="button" title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="${EXT_ID}-toolbar">
            <div id="${EXT_ID}-status" class="${EXT_ID}-status">未连接</div>
            <div class="${EXT_ID}-actions">
                <button id="${EXT_ID}-refresh" class="menu_button ${EXT_ID}-button" type="button"><i class="fa-solid fa-rotate"></i><span>刷新</span></button>
                <button id="${EXT_ID}-tag-manager-toggle" class="menu_button ${EXT_ID}-button" type="button" title="查看所有标签并批量删除"><i class="fa-solid fa-tags"></i><span>标签</span></button>
                <button id="${EXT_ID}-updates-toggle" class="menu_button ${EXT_ID}-button" type="button" title="查看版本和更新内容"><i class="fa-solid fa-circle-up"></i><span class="${EXT_ID}-update-button-label">更新</span><em class="${EXT_ID}-update-dot" hidden aria-hidden="true"></em></button>
                <button id="${EXT_ID}-settings-toggle" class="menu_button ${EXT_ID}-button" type="button"><i class="fa-solid fa-sliders"></i><span>设置</span></button>
            </div>
        </div>
        <div id="${EXT_ID}-settings" class="${EXT_ID}-settings" hidden>
            <div class="${EXT_ID}-subpage-head">
                <strong id="${EXT_ID}-settings-title"><i class="fa-solid fa-sliders"></i> 设置</strong>
                <button id="${EXT_ID}-settings-back" class="menu_button ${EXT_ID}-button" type="button"><i class="fa-solid fa-arrow-left"></i><span>返回收藏夹</span></button>
            </div>
            <div class="${EXT_ID}-settings-grid">
                <label>识别标签<input id="${EXT_ID}-tags" type="text" value="${htmlEscape(state.settings.tagNames.join(', '))}"></label>
                <label>details 关键词<input id="${EXT_ID}-keywords" type="text" value="${htmlEscape(state.settings.detailsKeywords.join(', '))}"></label>
            </div>
            <div class="${EXT_ID}-settings-row">
                <label class="${EXT_ID}-check"><input id="${EXT_ID}-loreframe-enabled" type="checkbox" ${state.settings.loreFrameEnabled ? 'checked' : ''}>兼容拟界文库（实验性）</label>
                <button id="${EXT_ID}-save-settings" class="menu_button ${EXT_ID}-button ${EXT_ID}-primary" type="button"><i class="fa-solid fa-check"></i><span>保存设置</span></button>
            </div>
            <div id="${EXT_ID}-health" class="${EXT_ID}-health"></div>
            <div id="${EXT_ID}-tag-manager" class="${EXT_ID}-tag-manager">
                <div class="${EXT_ID}-tag-manager-head">
                    <small><i class="fa-solid fa-circle-info" aria-hidden="true"></i> 移除标签不会删除收藏。</small>
                    <button id="${EXT_ID}-tag-manager-refresh" class="menu_button ${EXT_ID}-button" type="button" title="重新统计全部收藏的标签"><i class="fa-solid fa-rotate"></i><span>刷新标签</span></button>
                </div>
                <div id="${EXT_ID}-tag-manager-list" class="${EXT_ID}-tag-manager-list"><small>正在读取标签...</small></div>
            </div>
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
        <div id="${EXT_ID}-updates" class="${EXT_ID}-updates" hidden>
            <div class="${EXT_ID}-updates-head">
                <div>
                    <h2><i class="fa-solid fa-circle-up"></i> 插件更新</h2>
                    <p>首次打开收藏夹只检查一次版本号；本页读取完整内容。不会定时轮询或自动更新。</p>
                </div>
                <button id="${EXT_ID}-updates-back" class="menu_button ${EXT_ID}-button" type="button"><i class="fa-solid fa-arrow-left"></i><span>返回收藏夹</span></button>
            </div>
            <div class="${EXT_ID}-version-row">
                <div><small>当前版本</small><strong id="${EXT_ID}-current-version">读取中</strong></div>
                <i class="fa-solid fa-arrow-right"></i>
                <div><small>最新版本</small><strong id="${EXT_ID}-latest-version">读取中</strong></div>
            </div>
            <div id="${EXT_ID}-update-status" class="${EXT_ID}-update-status">尚未检查更新。</div>
            <div class="${EXT_ID}-update-actions">
                <button id="${EXT_ID}-check-update" class="menu_button ${EXT_ID}-button" type="button"><i class="fa-solid fa-rotate"></i><span>重新检查</span></button>
                <button id="${EXT_ID}-install-update" class="menu_button ${EXT_ID}-button ${EXT_ID}-primary" type="button" hidden><i class="fa-solid fa-download"></i><span>安装更新</span></button>
                <button id="${EXT_ID}-reload-after-update" class="menu_button ${EXT_ID}-button ${EXT_ID}-primary" type="button" hidden><i class="fa-solid fa-arrows-rotate"></i><span>刷新页面</span></button>
                <a class="menu_button ${EXT_ID}-button" href="https://github.com/kongkongmie/sillytavern-theater-favorites" target="_blank" rel="noopener"><i class="fa-brands fa-github"></i><span>手动更新</span></a>
            </div>
            <div class="${EXT_ID}-update-notes-title"><i class="fa-solid fa-list-check"></i><span>本次更新内容</span></div>
            <div id="${EXT_ID}-update-notes" class="${EXT_ID}-update-notes"><p>正在读取…</p></div>
        </div>
        <div class="${EXT_ID}-body">
            <div class="${EXT_ID}-rail-head">
                <span>收藏列表</span>
                <div class="${EXT_ID}-rail-tools">
                    <small>点开一条后，上一条会自动收起</small>
                    <button id="${EXT_ID}-filters-toggle" class="menu_button ${EXT_ID}-filter-toggle" type="button" aria-expanded="false" title="展开角色、聊天、来源和标签筛选"><i class="fa-solid fa-filter"></i><span>筛选</span><em id="${EXT_ID}-filter-count" hidden></em></button>
                </div>
            </div>
            <div class="${EXT_ID}-filters">
                <input id="${EXT_ID}-search" type="search" placeholder="搜索标题、角色、聊天或标签">
                <select id="${EXT_ID}-character"><option value="">全部角色</option></select>
                <select id="${EXT_ID}-chat"><option value="">全部聊天</option></select>
                <select id="${EXT_ID}-source"><option value="">全部来源</option></select>
                <select id="${EXT_ID}-tag"><option value="">全部标签</option></select>
            </div>
            <div id="${EXT_ID}-list" class="${EXT_ID}-list"></div>
            <div class="${EXT_ID}-pager">
                <button id="${EXT_ID}-prev" class="menu_button ${EXT_ID}-mini" type="button" title="上一页"><i class="fa-solid fa-chevron-left"></i></button>
                <span id="${EXT_ID}-page">1 / 1</span>
                <button id="${EXT_ID}-next" class="menu_button ${EXT_ID}-mini" type="button" title="下一页"><i class="fa-solid fa-chevron-right"></i></button>
            </div>
        </div>
    `;
    document.body.append(panel);
    panel.addEventListener('scroll', () => {
        if (panel.scrollTop || panel.scrollLeft) resetPanelShellScroll();
    }, { passive: true });
    document.querySelector(`#${EXT_ID}-close`)?.addEventListener('click', closePanel);
    document.querySelector(`#${EXT_ID}-refresh`)?.addEventListener('click', () => loadTheaters().catch(showError));
    document.querySelector(`#${EXT_ID}-tag-manager-toggle`)?.addEventListener('click', () => toggleTagManager().catch(showError));
    document.querySelector(`#${EXT_ID}-updates-toggle`)?.addEventListener('click', toggleUpdatesPage);
    document.querySelector(`#${EXT_ID}-updates-back`)?.addEventListener('click', closeSubPage);
    document.querySelector(`#${EXT_ID}-settings-back`)?.addEventListener('click', closeSubPage);
    document.querySelector(`#${EXT_ID}-check-update`)?.addEventListener('click', () => checkForExtensionUpdates().catch(showError));
    document.querySelector(`#${EXT_ID}-install-update`)?.addEventListener('click', () => installExtensionUpdate().catch(showError));
    document.querySelector(`#${EXT_ID}-reload-after-update`)?.addEventListener('click', () => window.location.reload());
    document.querySelector(`#${EXT_ID}-settings-toggle`)?.addEventListener('click', () => toggleSettingsPage().catch(showError));
    document.querySelector(`#${EXT_ID}-tag-manager-refresh`)?.addEventListener('click', () => loadTagManager().catch(showError));
    document.querySelector(`#${EXT_ID}-filters-toggle`)?.addEventListener('click', event => {
        const body = document.querySelector(`.${EXT_ID}-body`);
        const expanded = body?.classList.toggle(`${EXT_ID}-filters-open`) || false;
        event.currentTarget.setAttribute('aria-expanded', String(expanded));
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
            updateFilterToggle();
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

function renderTagManager(tags = []) {
    const target = document.querySelector(`#${EXT_ID}-tag-manager-list`);
    if (!target) return;
    if (!tags.length) {
        target.innerHTML = '<small>还没有收藏标签。</small>';
        return;
    }
    target.innerHTML = tags.map(item => `
        <div class="${EXT_ID}-tag-manager-item">
            <span><i class="fa-solid fa-tag"></i>${htmlEscape(item.name)}<small>${Number(item.count) || 0} 条收藏</small></span>
            <button class="menu_button ${EXT_ID}-button ${EXT_ID}-danger ${EXT_ID}-tag-manager-delete" type="button" data-tag="${attrEscape(item.name)}" data-count="${Number(item.count) || 0}" title="从全部收藏中删除标签 ${attrEscape(item.name)}"><i class="fa-solid fa-trash-can"></i><span>移除</span></button>
        </div>`).join('');
    target.querySelectorAll(`.${EXT_ID}-tag-manager-delete[data-tag]`).forEach(button => {
        button.addEventListener('click', () => deleteManagedTag(button.dataset.tag || '', Number(button.dataset.count) || 0).catch(showError));
    });
}

async function loadTagManager() {
    const data = await api('/tags');
    renderTagManager(data.tags || []);
}

async function toggleTagManager() {
    const settings = document.querySelector(`#${EXT_ID}-settings`);
    const panel = document.querySelector(`#${EXT_ID}-panel`);
    if (!settings || !panel) return;
    if (panel.classList.contains('tag-manager-open')) {
        setPanelView('list');
        return;
    }
    setPanelView('tags');
    await Promise.all([loadStorageStatus(), loadTagManager()]);
    const manager = document.querySelector(`#${EXT_ID}-tag-manager`);
    if (manager) {
        const settingsRect = settings.getBoundingClientRect();
        const managerRect = manager.getBoundingClientRect();
        settings.scrollTop = Math.max(0, settings.scrollTop + managerRect.top - settingsRect.top);
    }
    resetPanelShellScroll();
}

async function deleteManagedTag(tag, count) {
    if (!tag) return;
    const confirmed = window.confirm(`确定从 ${count} 条收藏中移除标签“${tag}”吗？\n\n收藏本身不会被删除。`);
    if (!confirmed) return;
    const data = await api(`/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' });
    if (state.filters.tag === tag) {
        state.filters.tag = '';
        state.page = 1;
    }
    renderTagManager(data.tags || []);
    await loadTheaters();
    notify(`已从 ${data.updated || 0} 条收藏中移除标签“${tag}”。`, 'success');
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
    addLoreFrameFavoriteButtons();
    renderHealthStatus();
    notify('设置已保存。', 'success');
}

function scrollListToTop() {
    window.setTimeout(() => {
        resetPanelShellScroll();
        const list = document.querySelector(`#${EXT_ID}-list`);
        if (list) list.scrollTop = 0;
    }, 0);
}

function scrollSelectedIntoView() {
    window.setTimeout(() => {
        resetPanelShellScroll();
        const list = document.querySelector(`#${EXT_ID}-list`);
        const active = document.querySelector(`.${EXT_ID}-entry.active`);
        if (!list || !active || !list.contains(active)) return;

        // Do not use scrollIntoView here. It may also scroll the fixed panel
        // (overflow:hidden is still programmatically scrollable), which hides
        // the header after a long entry is collapsed or deleted.
        const listRect = list.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        list.scrollTop = Math.max(0, list.scrollTop + activeRect.top - listRect.top);
    }, 0);
}

function resetPanelShellScroll() {
    const panel = document.querySelector(`#${EXT_ID}-panel`);
    if (!panel) return;
    panel.scrollTop = 0;
    panel.scrollLeft = 0;
}

function keepPanelInViewport() {
    window.setTimeout(() => {
        const panel = document.querySelector(`#${EXT_ID}-panel`);
        if (!panel || !state.open) return;
        resetPanelShellScroll();
        const rect = panel.getBoundingClientRect();
        const top = Math.max(8, rect.top);
        if (rect.top < 8) panel.style.top = `${top}px`;
    }, 0);
}

function openPanel() {
    buildPanel();
    setPanelView('list');
    state.open = true;
    document.querySelector(`#${EXT_ID}-panel`)?.classList.add('open');
    state.selectedId = '';
    keepPanelInViewport();
    checkUpdateHintOnce();
    loadTheaters().then(() => {
        scrollListToTop();
        keepPanelInViewport();
    }).catch(showError);
}

function closePanel() {
    state.open = false;
    const panel = document.querySelector(`#${EXT_ID}-panel`);
    panel?.classList.remove('open');
    if (panel) panel.style.top = '';
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
    resetPanelShellScroll();
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
    resetPanelShellScroll();
    keepPanelInViewport();
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
    updateFilterToggle();
}

function updateFilterToggle() {
    const count = ['character', 'chat', 'source', 'tag'].filter(name => Boolean(state.filters[name])).length;
    const badge = document.querySelector(`#${EXT_ID}-filter-count`);
    const button = document.querySelector(`#${EXT_ID}-filters-toggle`);
    if (badge) {
        badge.hidden = count === 0;
        badge.textContent = String(count);
    }
    if (button) button.classList.toggle('active', count > 0);
}

function sourceLabel(item) {
    if (item.sourceType === 'loreframe-html') return '拟界文库';
    if (item.sourceType === 'details') return 'details';
    if (item.sourceType === 'tag-markdown') return 'Markdown';
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
    if (!list.dataset.theaterFavoritesDelegated) {
        list.dataset.theaterFavoritesDelegated = '1';
        list.addEventListener('click', event => {
            const button = event.target.closest?.(`.${EXT_ID}-chatu8-generate[data-image-prompt]`);
            if (!button || !list.contains(button)) return;
            event.preventDefault();
            event.stopPropagation();
            generatePreviewImageWithChatu8(button);
        });
    }
    if (!state.items.length) {
        list.innerHTML = '<div class="theater-favorites-empty">还没有收藏。聊天里的小剧场旁会出现收藏按钮。</div>';
        return;
    }
    list.innerHTML = state.items.map((item, index) => `
        ${renderTheaterListItem(item, index)}
    `).join('');
    list.querySelectorAll(`.${EXT_ID}-item-toggle[data-id]`).forEach(button => {
        button.addEventListener('click', event => {
            if (event.target.closest(`.${EXT_ID}-drag-handle`)) return;
            selectTheater(button.dataset.id || '').catch(showError);
        });
    });
    initListSortable(list);
    list.querySelector(`#${EXT_ID}-read-prev`)?.addEventListener('click', () => selectNeighbor(-1));
    list.querySelector(`#${EXT_ID}-read-next`)?.addEventListener('click', () => selectNeighbor(1));
    list.querySelector(`#${EXT_ID}-move-up`)?.addEventListener('click', () => moveSelected('up').catch(showError));
    list.querySelector(`#${EXT_ID}-move-down`)?.addEventListener('click', () => moveSelected('down').catch(showError));
    list.querySelector(`#${EXT_ID}-delete`)?.addEventListener('click', () => deleteSelected().catch(showError));
    list.querySelector(`#${EXT_ID}-rename`)?.addEventListener('click', () => renameSelected().catch(showError));
    list.querySelector(`#${EXT_ID}-edit`)?.addEventListener('click', () => toggleSelectedEditor(true));
    list.querySelector(`#${EXT_ID}-edit-cancel`)?.addEventListener('click', () => toggleSelectedEditor(false));
    list.querySelector(`#${EXT_ID}-edit-save`)?.addEventListener('click', () => saveSelectedContent().catch(showError));
    list.querySelector(`#${EXT_ID}-tag-add`)?.addEventListener('click', () => addSelectedTag().catch(showError));
    list.querySelector(`#${EXT_ID}-tag-input`)?.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            addSelectedTag().catch(showError);
        }
    });
    list.querySelector(`.${EXT_ID}-item-tools`)?.addEventListener('toggle', event => {
        const item = state.items.find(entry => entry.id === state.selectedId);
        if (item) item.managementOpen = Boolean(event.currentTarget.open);
    });
    list.querySelectorAll(`.${EXT_ID}-tag-remove[data-tag]`).forEach(button => {
        button.addEventListener('click', () => removeSelectedTag(button.dataset.tag || '').catch(showError));
    });
}

function renderTheaterListItem(item) {
    const active = item.id === state.selectedId;
    const sourceLine = [item.character?.name, item.chat?.name, item.createdAt ? new Date(item.createdAt).toLocaleString() : ''].filter(Boolean).join(' · ');
    return `
        <article class="${EXT_ID}-entry ${active ? 'active' : ''}" data-id="${htmlEscape(item.id)}">
            <div class="${EXT_ID}-entry-head">
                <span class="${EXT_ID}-drag-handle" data-id="${htmlEscape(item.id)}" title="拖动排序" aria-label="拖动排序"><i class="fa-solid fa-grip-vertical"></i></span>
                <button class="${EXT_ID}-item-toggle" type="button" data-id="${htmlEscape(item.id)}" aria-expanded="${active ? 'true' : 'false'}">
                    <span class="${EXT_ID}-item-main">
                        <strong>${htmlEscape(item.title || '未命名小剧场')}</strong>
                        <span><em class="${EXT_ID}-source-badge">${htmlEscape(sourceLabel(item))}</em> ${htmlEscape([item.character?.name, item.chat?.name, item.sizeBytes ? formatBytes(item.sizeBytes) : ''].filter(Boolean).join(' · ') || '未知来源')}</span>
                    </span>
                    <i class="fa-solid fa-chevron-down ${EXT_ID}-item-chevron"></i>
                </button>
            </div>
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
    const editing = Boolean(item.editingContent);
    const compactItemTools = window.matchMedia?.('(max-width: 760px)').matches;
    const editorHtml = editing ? `
        <div class="${EXT_ID}-content-editor">
            <label for="${EXT_ID}-content-input">编辑原文</label>
            <textarea id="${EXT_ID}-content-input" spellcheck="false">${htmlEscape(editableSource(item))}</textarea>
            <div class="${EXT_ID}-content-editor-actions">
                <button id="${EXT_ID}-edit-save" class="menu_button ${EXT_ID}-button ${EXT_ID}-primary" type="button"><i class="fa-solid fa-floppy-disk"></i><span>保存正文</span></button>
                <button id="${EXT_ID}-edit-cancel" class="menu_button ${EXT_ID}-button" type="button"><i class="fa-solid fa-xmark"></i><span>取消</span></button>
            </div>
            <small>保存会更新这条收藏的原文、预览、搜索内容和去重签名；不会改聊天记录里的原消息。</small>
        </div>
    ` : '';
    return `
        <div class="${EXT_ID}-expanded">
            <details class="${EXT_ID}-item-tools" ${!compactItemTools || item.managementOpen ? 'open' : ''}>
                <summary><span><i class="fa-solid fa-screwdriver-wrench"></i>管理这条收藏</span><i class="fa-solid fa-chevron-down"></i></summary>
                <div class="${EXT_ID}-item-tools-content">
                    <div class="${EXT_ID}-reader-actions">
                        <button id="${EXT_ID}-read-prev" class="menu_button ${EXT_ID}-mini" type="button" title="上一条" ${selectedIndex <= 0 ? 'disabled' : ''}><i class="fa-solid fa-arrow-up"></i></button>
                        <button id="${EXT_ID}-read-next" class="menu_button ${EXT_ID}-mini" type="button" title="下一条" ${selectedIndex >= state.items.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-arrow-down"></i></button>
                        <button id="${EXT_ID}-move-up" class="menu_button ${EXT_ID}-button" type="button" ${absoluteIndex <= 1 ? 'disabled' : ''}><i class="fa-solid fa-arrow-up"></i><span>上移</span></button>
                        <button id="${EXT_ID}-move-down" class="menu_button ${EXT_ID}-button" type="button" ${absoluteIndex >= state.total ? 'disabled' : ''}><i class="fa-solid fa-arrow-down"></i><span>下移</span></button>
                        <button id="${EXT_ID}-delete" class="menu_button ${EXT_ID}-button ${EXT_ID}-danger" type="button"><i class="fa-solid fa-trash-can"></i><span>删除</span></button>
                        <button id="${EXT_ID}-rename" class="menu_button ${EXT_ID}-button" type="button"><i class="fa-solid fa-pen"></i><span>重命名</span></button>
                        <button id="${EXT_ID}-edit" class="menu_button ${EXT_ID}-button" type="button" ${editing ? 'disabled' : ''}><i class="fa-solid fa-file-pen"></i><span>编辑正文</span></button>
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
                </div>
            </details>
            ${editorHtml}
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

function toggleSelectedEditor(open) {
    const item = state.items.find(entry => entry.id === state.selectedId);
    if (!item) return;
    item.editingContent = Boolean(open);
    renderList();
}

async function saveSelectedContent() {
    const item = state.items.find(entry => entry.id === state.selectedId);
    const input = document.querySelector(`#${EXT_ID}-content-input`);
    if (!item || !input) return;
    const rawSource = String(input.value || '');
    if (!rawSource.trim()) return notify('正文不能为空。', 'error');
    await saveSelectedMetadata(item, {
        rawSource,
        renderedHtml: rawSource,
        plainText: sourceToPlainText(rawSource),
        sourceType: looksLikeRunnableMarkup(rawSource) ? (item.sourceType || 'edited') : 'tag-regex',
        sourceTag: item.sourceTag || '',
    });
    item.editingContent = false;
    renderList();
    state.savedSignaturesLoaded = false;
    await loadSavedSignatures({ force: true }).catch(() => {});
    notify('正文已保存。', 'success');
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
    item.managementOpen = true;
    await saveSelectedMetadata(item, { tags: [...(item.tags || []), tag] });
    const nextInput = document.querySelector(`#${EXT_ID}-tag-input`);
    if (nextInput) {
        nextInput.value = '';
        nextInput.focus({ preventScroll: true });
    }
    notify('标签已添加。', 'success');
}

async function removeSelectedTag(tag) {
    const item = state.items.find(entry => entry.id === state.selectedId);
    if (!item || !tag) return;
    await saveSelectedMetadata(item, { tags: (item.tags || []).filter(value => value !== tag) });
    notify('标签已删除。', 'success');
}

function initListSortable(list) {
    if (!list || !window.jQuery?.fn?.sortable) return;
    const $list = window.jQuery(list);
    if ($list.sortable('instance') !== undefined) $list.sortable('destroy');
    $list.sortable({
        items: `.${EXT_ID}-entry`,
        handle: `.${EXT_ID}-drag-handle`,
        delay: sortableDelay(),
        axis: 'y',
        tolerance: 'pointer',
        cancel: `.${EXT_ID}-expanded, input, textarea, select, button, a`,
        placeholder: `${EXT_ID}-drag-placeholder`,
        start: (_event, ui) => {
            ui.item.addClass(`${EXT_ID}-drag-source`);
            ui.placeholder.height(ui.item.outerHeight());
        },
        stop: async (_event, ui) => {
            ui.item.removeClass(`${EXT_ID}-drag-source`);
            const orderedIds = [...list.querySelectorAll(`.${EXT_ID}-entry[data-id]`)].map(entry => entry.dataset.id).filter(Boolean);
            if (orderedIds.length < 2) return;
            state.items = orderedIds.map(id => state.items.find(item => item.id === id)).filter(Boolean);
            await reorderVisibleTheaters(orderedIds).catch(showError);
        },
    });
}

async function reorderVisibleTheaters(orderedIds) {
    await api('/theaters/reorder', {
        method: 'POST',
        body: JSON.stringify({ orderedIds }),
    });
    notify('顺序已保存。', 'success');
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
    scrollSelectedIntoView();
    if (item?.detailLoaded) return;

    state.detailLoadingId = id;
    const data = await api(`/theaters/${encodeURIComponent(id)}`);
    const index = state.items.findIndex(entry => entry.id === id);
    if (index >= 0) state.items[index] = { ...state.items[index], ...data.theater, detailLoaded: true };
    if (state.detailLoadingId === id) state.detailLoadingId = '';
    renderList();
    if (state.selectedId === id) {
        scrollSelectedIntoView();
    }
}

function selectNeighbor(delta) {
    const currentIndex = state.items.findIndex(entry => entry.id === state.selectedId);
    const next = state.items[currentIndex + delta];
    if (!next) return;
    selectTheater(next.id).catch(showError);
}

async function moveSelected(direction) {
    if (!state.selectedId) return;
    const query = new URLSearchParams({ limit: state.pageSize, offset: (state.page - 1) * state.pageSize });
    Object.entries(state.filters).forEach(([key, value]) => { if (value) query.set(key, value); });
    await api(`/theaters/${encodeURIComponent(state.selectedId)}/move?${query}`, {
        method: 'POST',
        body: JSON.stringify({ direction }),
    });
    await loadTheaters();
    notify(direction === 'up' ? '已上移。' : '已下移。', 'success');
}

async function deleteSelected() {
    if (!state.selectedId) return;
    resetPanelShellScroll();
    await api(`/theaters/${encodeURIComponent(state.selectedId)}`, { method: 'DELETE' });
    state.selectedId = '';
    // Candidate ids are session-local shortcuts. A deleted favorite must no
    // longer remain saved merely because its old chat candidate id is cached.
    state.savedCandidateIds.clear();
    state.savedSignaturesLoaded = false;
    await loadSavedSignatures({ force: true }).catch(() => {});
    await loadTheaters();
    addFavoriteButtons();
    resetPanelShellScroll();
}

function changePage(delta) {
    const maxPage = Math.max(1, Math.ceil(state.total / state.pageSize));
    state.page = Math.min(Math.max(1, state.page + delta), maxPage);
    loadTheaters().catch(showError);
}

function reliableIconMarkup(className) {
    return `<span class="${className} ${EXT_ID}-reliable-icon" aria-hidden="true"><i class="fa-solid fa-masks-theater"></i></span>`;
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
        button = document.createElement('div');
        button.id = `${EXT_ID}-open`;
        button.className = `${EXT_ID}-qr qr--button interactable`;
        button.tabIndex = 0;
        button.setAttribute('role', 'button');
        button.title = '小剧场收藏夹';
        button.setAttribute('aria-label', '打开小剧场收藏夹');
        button.innerHTML = reliableIconMarkup(`${EXT_ID}-qr-icon`);
        button.addEventListener('click', togglePanel);
        button.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                togglePanel();
            }
        });
    }
    button.classList.add(`${EXT_ID}-qr`, 'qr--button', 'interactable');
    if (!button.querySelector(`.${EXT_ID}-reliable-icon`)) button.innerHTML = reliableIconMarkup(`${EXT_ID}-qr-icon`);
    button.removeAttribute('type');
    button.setAttribute('role', 'button');
    button.tabIndex = 0;
    button.classList.toggle(`${EXT_ID}-send-form-launcher`, target === sendFormTarget);
    if (button.parentElement !== target || target.firstElementChild !== button) target.prepend(button);
    cleanupDuplicateLaunchers(button);
}

function cleanupDuplicateLaunchers(activeButton) {
    activeButton.classList.remove(`${EXT_ID}-duplicate-launcher`);
    activeButton.removeAttribute('aria-hidden');
    const roots = [
        document.querySelector('#qr--bar'),
        document.querySelector('#rightSendForm'),
        document.querySelector('#leftSendForm'),
    ].filter(Boolean);
    roots.forEach(root => {
        const duplicateNodes = new Set();
        root.querySelectorAll(`#${EXT_ID}-open, .${EXT_ID}-qr`).forEach(launcher => {
            if (launcher !== activeButton) duplicateNodes.add(launcher);
        });
        duplicateNodes.forEach(node => {
            node.classList.add(`${EXT_ID}-duplicate-launcher`);
            node.setAttribute('aria-hidden', 'true');
        });
    });
}

function addMenuEntry() {
    const menu = document.querySelector('#extensionsMenu');
    if (!menu) return;
    let entry = document.querySelector(`#${EXT_ID}-menu-entry`);
    if (!entry) {
        entry = document.createElement('div');
        entry.id = `${EXT_ID}-menu-entry`;
        entry.className = 'list-group-item flex-container flexGap5 interactable';
        entry.tabIndex = 0;
        menu.append(entry);
    }
    entry.title = '打开小剧场收藏夹';
    if (!entry.querySelector(`.${EXT_ID}-reliable-icon`) || entry.querySelector('span:last-child')?.textContent !== '小剧场收藏夹') {
        entry.innerHTML = `${reliableIconMarkup(`${EXT_ID}-menu-icon`)}<span>小剧场收藏夹</span>`;
    }
    if (!entry.dataset.theaterFavoritesBound) {
        entry.dataset.theaterFavoritesBound = '1';
        entry.addEventListener('click', openPanel);
        entry.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openPanel();
            }
        });
    }
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
    document.addEventListener('click', handleLoreFrameInteraction, true);
    window.addEventListener('resize', handleLoreFrameResize);
    globalThis.TheaterFavoritesOpen = openPanel;
    addLoreFrameFavoriteButtons();
    loadSavedSignatures().catch(() => {}).finally(() => addFavoriteButtons());
}

if (eventSource?.on && event_types?.APP_READY) {
    eventSource.on(event_types.APP_READY, init);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    window.setTimeout(init, 0);
}
