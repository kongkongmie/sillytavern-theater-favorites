import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = file => 'data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(root, file))).toString('base64');
let source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
source = source.slice(source.indexOf("const EXT_ID"), source.indexOf('if (eventSource?.on'));
source = source.replace(/const EXTENSION_BASE_URL = .*?;/, "const EXTENSION_BASE_URL = 'http://127.0.0.1:8000/scripts/extensions/third-party/theater-favorites';");
const harness = `import {createTauriStorage} from '${moduleUrl('tauri-storage.js')}';
import {createReadingExport} from '${moduleUrl('reading-export.js')}';
const chat=[],characters=[],this_chid=0,eventSource={},event_types={};
const getCurrentChatId=()=>null,getRequestHeaders=()=>({}),messageFormatting=value=>value;
const records=new Map();
window.__TAURITAVERN__={ready:Promise.resolve(),api:{extension:{store:{
tryGetJson:async({key})=>records.has(key)?{found:true,value:structuredClone(records.get(key))}:{found:false},
setJson:async({key,value})=>records.set(key,structuredClone(value)),
deleteJson:async({key})=>records.delete(key),listKeys:async()=>[...records.keys()]
}}}};
window.fetch=async()=>({ok:true,json:async()=>({version:'0.4.10',latest:'0.4.10',releases:[]})});
${source}
for(let i=1;i<=25;i++)await tauriStorage.request('/theaters',{method:'POST',body:{title:'测试收藏 '+i,rawSource:'# 测试标题 '+i+'\\n\\n正文 **加粗**',sourceType:'tag-regex',sourceTag:'snow',sortOrder:i}});
buildPanel();await openPanel();
window.fixture={api:tauriStorage.request,preview:buildPreviewHtml,export:createReadingExport,storage:tauriStorage};
document.body.dataset.fixtureReady='true';`;
const output = path.join(root, 'output', 'playwright');
fs.mkdirSync(output, { recursive: true });
const script = 'data:text/javascript;base64,' + Buffer.from(harness).toString('base64');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
fs.writeFileSync(path.join(output, 'tauri-fixture.html'), `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#111}.menu_button{padding:6px}</style><style>${css}</style><script type="module" src="${script}"></script>`);
console.log('Generated isolated Tauri UI fixture in output/playwright. No real user data is used.');
