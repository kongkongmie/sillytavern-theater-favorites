import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');

assert.match(styles, /#theater-favorites-panel\.open\s*\{[\s\S]*?grid-template-rows:\s*auto auto minmax\(0, 1fr\);/, 'default panel must give its body the remaining height');
assert.match(styles, /\.theater-favorites-body\s*\{[\s\S]*?grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto;/, 'the body must reserve its own final row for pagination');
assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?#theater-favorites-panel\.open\s*\{\s*grid-template-rows:\s*auto auto minmax\(0, 1fr\);/, 'mobile layout must not restore the obsolete overflowing panel rows');
assert.match(styles, /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/, 'mobile toolbar actions must share the available width');
assert.doesNotMatch(source, /插件更新[\s\S]{0,100}@KKM/, 'the update page must not expose internal attribution notes');
assert.match(source, /const maximum = Math\.max\(minimum, Math\.min\(900, Math\.round\(window\.innerHeight \* 0\.72\)\)\);/, 'HTML previews must be capped to the viewport');
assert.doesNotMatch(source, /const maximum = 30000;/, 'HTML previews must never expand to an effectively unlimited height');
assert.match(source, /natural>viewport\+8\?viewport\/natural:1/, 'fixed-width HTML previews must scale down to the iframe viewport');
assert.match(source, /naturalHeight\*scale/, 'scaled previews must report their visual height rather than unscaled height');
assert.match(source, /type: innerIsMarkup \? 'tag-html' : \(renderedRegex \? 'tag-rendered'/, 'rendered regex snapshots must take priority over raw Markdown');
assert.match(source, /item\.sourceType === 'tag-rendered'/, 'rendered regex snapshots must have a dedicated preview path');
const buildPreviewBody = source.match(/function buildPreviewHtml\(item\) \{([\s\S]*?)\n\}\n\nfunction handlePreviewResize/)?.[1] || '';
assert.ok(buildPreviewBody.indexOf('const savedRunnable = bestRunnableHtml(item, rawBody)') < buildPreviewBody.indexOf("if (inlineBody && /<details\\b/i.test(inlineBody))"), 'saved runnable regex HTML must win before structured details fallback');
assert.ok(buildPreviewBody.indexOf("compactRenderedMarkdownSnapshot(item.renderedHtml || '')") < buildPreviewBody.indexOf('if (item.sourceTag && item.rawSource)'), 'saved rendered Markdown must win before live regex and raw-source fallbacks');
assert.match(source, /details > br, snow > br, ccd > br/, 'rendered Markdown snapshots must remove formatter spacer breaks');
assert.match(source, /if \(item\.sourceTag && item\.rawSource\)/, 'all tagged theaters, including tag-html, must try the current display regex');
assert.match(source, /messageFormatting\(item\.rawSource, item\.character\?\.name \|\| '', false, false, -1\)/, 'display regex formatting must retain the complete outer source tag');
assert.match(source, /&& !stillHasSourceTag && hasRendererMarkup\)/, 'plain Markdown formatting must not bypass the compact Markdown preview');
assert.match(source, /async function deleteSelected\(\)[\s\S]*?state\.savedCandidateIds\.clear\(\);[\s\S]*?loadSavedSignatures\(\{ force: true \}\)[\s\S]*?addFavoriteButtons\(\);/, 'deleting a favorite must clear stale saved-button ids and refresh chat buttons');

console.log('preview layout regression: ok');
