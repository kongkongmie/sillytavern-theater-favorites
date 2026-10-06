const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// Preview contents live in inert templates until their article is opened.
export function createReadingExport(items, renderPreview, styles = '') {
    const entries = items.map((item, index) => {
        const metadata = [item.character?.name, item.chat?.name, ...(item.tags || [])].filter(Boolean).join(' · ');
        return `<article><button class="reading-title" type="button" aria-expanded="false">${index + 1}. ${escape(item.title)}</button><section hidden><p>${escape(metadata)}</p><div class="theater-favorites-preview mes_text mes_block"></div></section><template>${renderPreview(item)}</template></article>`;
    }).join('');
    const css = styles.replace(/<\/style/gi, '<\\/style');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小剧场收藏夹</title><style>${css}
html,body{margin:0!important;padding:0!important;overflow:auto!important;height:auto!important;min-height:0!important;background:#191b25!important;color:#ebe7de!important}
#theater-favorites-panel{position:static!important;display:block!important;transform:none!important;margin:0 auto!important;padding:16px!important;width:100%!important;max-width:980px!important;height:auto!important;max-height:none!important;box-sizing:border-box!important;overflow:visible!important}
.reading-title{display:block;width:100%;text-align:left;padding:14px 0;border:0;border-bottom:1px solid #444;background:transparent;color:#ebe7de;font:inherit;cursor:pointer}article>section{padding:12px 0}article>section[hidden]{display:none!important}article>section>p{color:#aaa}.theater-favorites-html-frame{width:100%!important;height:72vh;max-height:1200px;border:0}h1{font-size:24px}
</style></head><body><main id="theater-favorites-panel"><h1>小剧场收藏夹</h1><p>${items.length} 条收藏 · ${escape(new Date().toLocaleString())}</p>${entries}</main><script>
document.addEventListener('click',function(event){var button=event.target.closest('.reading-title');if(!button)return;var article=button.closest('article');var section=article.querySelector('section');if(section.hidden){document.querySelectorAll('article>section').forEach(function(other){other.hidden=true;other.previousElementSibling.setAttribute('aria-expanded','false')});if(!article.dataset.loaded){section.querySelector('.theater-favorites-preview').append(article.querySelector('template').content.cloneNode(true));article.dataset.loaded='true'}section.hidden=false;button.setAttribute('aria-expanded','true')}else{section.hidden=true;button.setAttribute('aria-expanded','false')}});
window.addEventListener('message',function(event){var data=event.data;if(!data||data.type!=='theater-favorites-resize')return;document.querySelectorAll('iframe[data-resize-token]').forEach(function(frame){if(frame.contentWindow===event.source&&frame.dataset.resizeToken===data.token){var height=Number(data.height);if(Number.isFinite(height))frame.style.height=Math.min(1200,Math.max(200,height))+'px'}})});
</script></body></html>`;
}
