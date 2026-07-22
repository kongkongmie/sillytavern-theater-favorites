import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

assert.doesNotMatch(source, /new MutationObserver\(scheduleScan\)/, 'document observer must not trigger a full-page scan');
assert.match(source, /new MutationObserver\(handleDocumentMutations\)/, 'document observer must use the incremental mutation handler');
assert.doesNotMatch(source, /setInterval\(addLoreFrameFavoriteButtons\s*,/, 'LoreFrame detection must not use a fixed polling loop');
assert.match(source, /if \(mutationIsExtensionOwned\(mutation\)\) return;/, 'extension-owned DOM mutations must be ignored');
assert.match(source, /scheduleMessageScans\(messages\)/, 'only affected messages should be queued');
assert.doesNotMatch(source, /querySelectorAll\?\.\('#chat \.mes, \.mes'\)/, 'a mutation on #chat must not collect every historical message');
assert.match(source, /getCandidatesForMessage\(messageElement\)/, 'button clicks must re-read the current message before saving');

const stripBody = source.match(/function stripGenerationPromptBlocks\(html\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.ok(stripBody, 'stripGenerationPromptBlocks must exist');
assert.doesNotMatch(stripBody, /replaceGenerationPromptBlocks|querySelector|iframe/, 'prompt stripping must not search the live page');

const bridgeLine = source.split('\n').find(line => line.includes('theater-favorites-resize') && line.includes('MutationObserver')) || '';
assert.ok(bridgeLine, 'preview resize bridge must exist');
assert.doesNotMatch(bridgeLine, /attributes:true/, 'preview resize observer must ignore attribute animation churn');
assert.match(bridgeLine, /lastHeight/, 'preview resize messages must be height-deduplicated');

console.log('performance regression: ok');
