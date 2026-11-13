import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const functionSource = name => {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} exists`);
    const end = source.indexOf('\nfunction ', start + 1);
    return source.slice(start, end);
};
const functions = ['extractStandaloneHtml', 'extractHtmlCodeBlock', 'extractRunnableHtml', 'thRenderRunnableHtml', 'buildPreviewHtml'].map(functionSource).join('\n');
const realPath = process.env.THEATER_SAMPLE;
const realItem = realPath ? JSON.parse(fs.readFileSync(realPath, 'utf8')) : null;
const sample = '<div class="TH-render"><pre class="hidden!"><code class="custom-html">&lt;!DOCTYPE html&gt;&lt;html&gt;&lt;body&gt;&lt;h1&gt;Phone preview&lt;/h1&gt;&lt;/body&gt;&lt;/html&gt;</code></pre><iframe style="height:10px"></iframe></div>';
const data = JSON.stringify({ sample, realItem }).replaceAll('<', '\\u003c');
const html = `<!DOCTYPE html><body><output id="result">pending</output><script>
const {sample, realItem} = ${data};
const EXT_ID = 'theater-favorites';
const stripOuterSourceTag = value => value || '';
const stripConfiguredTags = value => value || '';
const attrEscape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const addPreviewResizeBridge = value => value;
const openDetailsForFrame = value => value;
const bestRunnableHtml = () => '';
const messageFormatting = () => '<pre><code class="custom-html">&lt;!DOCTYPE html&gt;&lt;html&gt;&lt;body&gt;&lt;h1&gt;Phone preview&lt;/h1&gt;&lt;/body&gt;&lt;/html&gt;</code></pre>';
const hasSelfContainedRendererMarkup = value => /style=/.test(value);
const hasClassBasedRendererMarkup = () => false;
const compactRenderedMarkdownSnapshot = () => '';
const sanitizeInlinePreview = value => value;
${functions}
try {
  const saved = buildPreviewHtml({id:'saved',sourceType:'tag-rendered',renderedHtml:sample});
  const live = buildPreviewHtml({id:'live',sourceType:'tag-regex',sourceTag:'jianshouji',rawSource:'<jianshouji>phone</jianshouji>'});
  for (const result of [saved, live]) {
    const template = document.createElement('template'); template.innerHTML = result;
    const frame = template.content.querySelector('iframe');
    if (!frame || !frame.srcdoc.includes('<h1>Phone preview</h1>') || frame.srcdoc.includes('TH-render')) throw Error('TH-render wrapper was not unwrapped');
  }
  if (thRenderRunnableHtml('<div class="other"><pre><code>&lt;html&gt;&lt;/html&gt;</code></pre></div>')) throw Error('unrelated code block was unwrapped');
  if (realItem) {
    const runnable = thRenderRunnableHtml(realItem.renderedHtml);
    if (!runnable.startsWith('<!DOCTYPE html>') || !runnable.includes('</html>')) throw Error('saved sample was not extracted');
    const template = document.createElement('template'); template.innerHTML = buildPreviewHtml(realItem);
    const frame = template.content.querySelector('iframe');
    if (!frame || !frame.srcdoc.includes('<title>捡手机</title>') || frame.srcdoc.includes('TH-collapse-code-block-button')) throw Error('saved sample preview contains wrapper');
  }
  document.querySelector('#result').textContent = 'PASS';
} catch (error) { document.querySelector('#result').textContent = 'FAIL: ' + error.message; }
</script></body>`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theater-preview-test-'));
try {
    const file = path.join(dir, 'test.html');
    fs.writeFileSync(file, html);
    const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const output = execFileSync(chrome, ['--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${path.join(dir, 'profile')}`, '--dump-dom', pathToFileURL(file).href], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
    assert.match(output, /<output id="result">PASS<\/output>/, 'browser preview regression');
    console.log(`TH-render regression: ok${realItem ? ' (including saved sample)' : ''}`);
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
