import assert from 'node:assert/strict';
import fs from 'node:fs';

const sample = fs.readFileSync(new URL('./fixtures/nested-snow-details.txt', import.meta.url), 'utf8');
const inner = sample.replace(/^<snow\b[^>]*>/i, '').replace(/<\/snow>\s*$/i, '');
const looksLikeRunnableMarkup = value => /<(?:!doctype|html|head|body|style|script|link|meta|div|section|article|details|summary|table|ul|ol|li|p|br|span|img|button|input|select|textarea|canvas|svg)\b/i.test(value);
const stripGenerationPromptBlocks = html => String(html || '')
    .replace(/<image\b[^>]*>[\s\S]*?<imgthink\b[^>]*>[\s\S]*?<\/imgthink>[\s\S]*?<\/image>/gi, '')
    .replace(/<imgthink\b[^>]*>[\s\S]*?<\/imgthink>/gi, '');
const isPersistentImageReference = value => {
    const source = String(value || '').trim();
    if (!source || /^(?:data|blob|javascript|file):/i.test(source)) return false;
    const url = new URL(source, 'http://127.0.0.1:8000/');
    return url.protocol === 'http:' || url.protocol === 'https:';
};

assert.equal(looksLikeRunnableMarkup(inner), true, 'nested details must be classified as renderable markup');
const previewSource = stripGenerationPromptBlocks(inner);
assert.match(previewSource, /<details>/i, 'details wrapper must remain available to the preview');
assert.match(previewSource, /<summary>【小剧场测试】<\/summary>/i, 'summary must remain available to the preview');
assert.match(previewSource, /臣亮言/);
assert.match(previewSource, /不知所云/);
assert.doesNotMatch(previewSource, /imgthink|图片生成提示词|image###/i, 'generation prompts must not leak into reading text');
assert.match(previewSource, /崩殂。\n{2,}今当远离/, 'blank lines between paragraphs must survive prompt removal');
assert.equal(isPersistentImageReference('/user/images/theater/example.png'), true);
assert.equal(isPersistentImageReference('https://example.com/theater.png'), true);
assert.equal(isPersistentImageReference('data:image/png;base64,AAAA'), false, 'embedded image bytes must not be stored as a reference');
assert.equal(isPersistentImageReference('blob:http://127.0.0.1/example'), false, 'temporary blob URLs must not be stored');
const generationBlock = inner.match(/<image\b[^>]*>([\s\S]*?)<imgthink\b[^>]*>[\s\S]*?<\/imgthink>([\s\S]*?)<\/image>/i);
assert.equal(generationBlock?.[2]?.trim(), 'image###prompt###', '智绘姬 prompt must remain intact after imgthink');

console.log('nested tag regression: ok');
