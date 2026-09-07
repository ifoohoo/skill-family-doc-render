/**
 * Pure domain template: no file access, Markdown parsing, network, or publication.
 * @typedef {string|{type:'strong'|'em',content:Inline[]}|{type:'code',text:string}|{type:'link',href:string,content:Inline[]}} Inline
 * @typedef {{type:'paragraph',content:Inline[]}|{type:'heading',level:2|3|4,id:string,content:Inline[]}|{type:'list',ordered:boolean,items:Inline[][]}|{type:'table',headers:Inline[][],rows:Inline[][][]}|{type:'code',language:string,text:string}|{type:'callout',tone:'NOTE'|'TIP'|'WARNING',content:Inline[]}|{type:'image',src:string,alt:string}} Block
 * @typedef {{id:string,title:string,navTitle?:string,role:'overview'|'setup'|'first-success'|'maintenance'|'release'|'troubleshooting'|'upgrade'|'reference',kind:'home'|'task'|'reference'|'troubleshooting',group:string,order:number,inPager:boolean,blocks:Block[]}} Page
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ROLES = new Set(['overview', 'setup', 'first-success', 'maintenance', 'release', 'troubleshooting', 'upgrade', 'reference']);
const KINDS = new Set(['home', 'task', 'reference', 'troubleshooting']);
const escape = value => value.replace(/[&<>"'\r]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\r': '&#13;' })[character]);
const fail = message => { throw new TypeError(`editorial: ${message}`); };
function object(value, keys, at) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${at} must be a plain object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${at}: unsupported field ${key}`);
}
function string(value, at, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || /\u0000/.test(value)) fail(`${at} must be ${allowEmpty ? 'a' : 'a nonempty'} string without NUL`);
}
function id(value, at) {
  if (typeof value !== 'string' || !ID.test(value) || value.startsWith('editorial-')) fail(`${at}: invalid or reserved ID`);
}
function array(value, at, nonempty = true) {
  if (!Array.isArray(value) || (nonempty && !value.length)) fail(`${at} must be ${nonempty ? 'a nonempty' : 'an'} array`);
}
function href(value, page, pages) {
  string(value, 'link.href');
  if (/[\s\\<>"'\u0000-\u001f\u007f]/u.test(value)) fail(`unsafe link: ${value}`);
  if (/^https?:\/\//.test(value)) {
    let url;
    try { url = new URL(value); } catch { fail(`invalid external URL: ${value}`); }
    if (!url.hostname || url.username || url.password) fail(`invalid external URL: ${value}`);
    return;
  }
  if (/^mailto:[^@:?/#]+@[^@:?/#]+$/.test(value)) return;
  const match = /^(?:\.\/)?(?:([A-Za-z0-9][A-Za-z0-9_-]*)\.html)?(?:#([A-Za-z0-9][A-Za-z0-9_-]*))?$/.exec(value);
  if (!match || (!match[1] && !match[2])) fail(`unsupported link: ${value}`);
  const target = match[1] ? pages.get(match[1]) : page;
  if (!target || (match[2] && !target.anchors.has(match[2]))) fail(`unresolved site link: ${value}`);
}
function inline(content, page, pages, nestedLink = false) {
  array(content, 'inline content', false);
  for (const node of content) {
    if (typeof node === 'string') { string(node, 'inline text', true); continue; }
    if (node?.type === 'code') {
      object(node, ['type', 'text'], 'inline code'); string(node.text, 'inline code.text', true);
    } else if (node?.type === 'strong' || node?.type === 'em') {
      object(node, ['type', 'content'], 'inline emphasis'); inline(node.content, page, pages, nestedLink);
    } else if (node?.type === 'link') {
      if (nestedLink) fail('nested links are not supported');
      object(node, ['type', 'href', 'content'], 'inline link'); href(node.href, page, pages); inline(node.content, page, pages, true);
      if (!plainInline(node.content).trim()) fail('link requires readable content');
    } else fail('unsupported inline node');
  }
}
function plainInline(content) {
  return content.map(node => typeof node === 'string' ? node : node.type === 'code' ? node.text : plainInline(node.content)).join('');
}
function renderInline(content) {
  return content.map(node => {
    if (typeof node === 'string') return escape(node);
    if (node.type === 'code') return `<code>${escape(node.text)}</code>`;
    if (node.type === 'link') return `<a href="${escape(node.href)}">${renderInline(node.content)}</a>`;
    return `<${node.type}>${renderInline(node.content)}</${node.type}>`;
  }).join('');
}
function validateBlock(block, page, pages) {
  switch (block?.type) {
    case 'paragraph':
      object(block, ['type', 'content'], 'paragraph'); inline(block.content, page, pages); break;
    case 'heading':
      object(block, ['type', 'level', 'id', 'content'], 'heading');
      if (![2, 3, 4].includes(block.level)) fail('heading.level must be 2, 3, or 4');
      inline(block.content, page, pages);
      if (!plainInline(block.content).trim()) fail('heading requires readable content');
      break;
    case 'list':
      object(block, ['type', 'ordered', 'items'], 'list');
      if (typeof block.ordered !== 'boolean') fail('list.ordered must be boolean');
      array(block.items, 'list.items'); block.items.forEach(item => inline(item, page, pages)); break;
    case 'table':
      object(block, ['type', 'headers', 'rows'], 'table');
      array(block.headers, 'table.headers'); block.headers.forEach(cell => inline(cell, page, pages));
      array(block.rows, 'table.rows', false);
      block.rows.forEach(row => {
        array(row, 'table row');
        if (row.length !== block.headers.length) fail('table row width must match headers');
        row.forEach(cell => inline(cell, page, pages));
      }); break;
    case 'code':
      object(block, ['type', 'language', 'text'], 'code');
      if (typeof block.language !== 'string' || !/^[a-z0-9][a-z0-9+#.-]*$/.test(block.language)) fail('invalid code language');
      string(block.text, 'code.text', true); break;
    case 'callout':
      object(block, ['type', 'tone', 'content'], 'callout');
      if (!['NOTE', 'TIP', 'WARNING'].includes(block.tone)) fail('unsupported callout tone');
      inline(block.content, page, pages); break;
    case 'image':
      object(block, ['type', 'src', 'alt'], 'image');
      if (typeof block.src !== 'string' || !/^assets\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.svg$/.test(block.src) || block.src.startsWith('assets/editorial/')) fail('image.src must reference a site SVG outside reserved template assets');
      string(block.alt, 'image.alt'); break;
    default: fail('unsupported content block');
  }
}
function plainBlock(block) {
  if (block.content) return plainInline(block.content);
  if (block.type === 'list') return block.items.map(plainInline).join(' ');
  if (block.type === 'table') return [block.headers, ...block.rows].flat().map(plainInline).join(' ');
  if (block.type === 'code') return block.text;
  if (block.type === 'image') return block.alt;
  return '';
}
function normalize(model) {
  object(model, ['site', 'groups', 'pages'], 'model');
  object(model.site, ['title', 'description', 'productKind'], 'site');
  string(model.site.title, 'site.title'); string(model.site.description, 'site.description');
  if (!['plugin', 'library'].includes(model.site.productKind)) fail('invalid productKind');
  array(model.groups, 'groups'); array(model.pages, 'pages');
  const groupIds = new Set();
  for (const group of model.groups) {
    object(group, ['id', 'title'], 'group'); id(group.id, 'group.id'); string(group.title, 'group.title');
    if (groupIds.has(group.id)) fail('duplicate group ID');
    groupIds.add(group.id);
  }
  const pageMap = new Map();
  const orders = new Set();
  for (const page of model.pages) {
    object(page, ['id', 'title', 'navTitle', 'role', 'kind', 'group', 'order', 'inPager', 'blocks'], 'page');
    id(page.id, 'page.id'); string(page.title, 'page.title');
    if (page.id === 'content' || page.id === 'editorial-main') fail('page.id: invalid or reserved ID');
    if (page.navTitle !== undefined) string(page.navTitle, 'page.navTitle');
    if (pageMap.has(page.id)) fail('duplicate page ID');
    if (!groupIds.has(page.group)) fail('unknown page group');
    if (!ROLES.has(page.role) || !KINDS.has(page.kind)) fail('invalid page role or kind');
    if ((page.kind === 'home') !== (page.role === 'overview')) fail('home kind and overview role must occur together');
    if (typeof page.inPager !== 'boolean' || (page.inPager && page.kind !== 'task')) fail('inPager must be boolean and only task pages may join the tutorial');
    if (!Number.isSafeInteger(page.order) || orders.has(page.order)) fail('page.order must be a unique safe integer');
    orders.add(page.order);
    array(page.blocks, 'page.blocks');
    if (page.blocks[0]?.type !== 'paragraph') fail('page must start with its introductory paragraph');
    const anchors = new Set([page.id, 'content', 'editorial-main']);
    for (const block of page.blocks) if (block?.type === 'heading') {
      id(block.id, 'heading.id');
      if (anchors.has(block.id)) fail('duplicate page or heading ID');
      anchors.add(block.id);
    }
    pageMap.set(page.id, { ...page, anchors });
  }
  const pages = [...pageMap.values()].sort((a, b) => a.order - b.order);
  if (pages.filter(page => page.kind === 'home').length !== 1) fail('exactly one home page is required');
  for (const page of pages) {
    page.blocks.forEach(block => validateBlock(block, page, pageMap));
    if (!plainInline(page.blocks[0].content).trim()) fail('introductory paragraph must not be empty');
  }
  return { ...model, pages };
}
const label = page => page.navTitle ?? page.title;
const pageHref = page => `${page.id}.html`;
const searchIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 4.5 4.5"></path></svg>';
function navigation(model, current) {
  return model.groups.map(group => {
    const pages = model.pages.filter(page => page.group === group.id);
    if (!pages.length) return '';
    return `<div class="nav-group"><p>${escape(group.title)}</p>${pages.map(page => `<a href="${pageHref(page)}"${page === current ? ' aria-current="page"' : ''}>${escape(label(page))}</a>`).join('')}</div>`;
  }).join('\n');
}
function blockHtml(block, index) {
  switch (block.type) {
    case 'paragraph': return `<p>${renderInline(block.content)}</p>`;
    case 'heading': return `<h${block.level} id="${block.id}" tabindex="-1">${renderInline(block.content)} <a class="heading-link" href="#${block.id}" aria-label="定位章节：${escape(plainInline(block.content))}">#</a><button class="heading-copy" data-copy-link="${block.id}" aria-label="复制章节链接：${escape(plainInline(block.content))}" hidden>复制链接</button></h${block.level}>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      return `<${tag} class="content-list">${block.items.map(item => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`;
    }
    case 'table': return `<div class="table-scroll" role="region" tabindex="0" aria-label="内容表格，可横向滚动"><table><thead><tr>${block.headers.map(cell => `<th scope="col">${renderInline(cell)}</th>`).join('')}</tr></thead><tbody>${block.rows.map(row => `<tr>${row.map(cell => `<td>${renderInline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    case 'code': {
      const prompt = block.language === 'prompt';
      return `<div class="${prompt ? 'prompt-box' : 'code-block'}"><div class="block-heading"><span>${prompt ? '操作提示词' : escape(block.language)}</span><button class="copy-button" data-copy="editorial-code-${index}" hidden>${prompt ? '复制提示词' : '复制代码'}</button></div><pre tabindex="0"${prompt ? ' class="prompt-content"' : ''}><code id="editorial-code-${index}">${escape(block.text)}</code></pre></div>`;
    }
    case 'callout': return `<aside class="callout${block.tone === 'WARNING' ? ' warning' : ''}"><span class="note-symbol" aria-hidden="true">${block.tone === 'WARNING' ? '!' : 'i'}</span><div><strong>${{ NOTE: '说明', TIP: '建议', WARNING: '注意' }[block.tone]}</strong><p>${renderInline(block.content)}</p></div></aside>`;
    case 'image': return `<figure><img src="${escape(block.src)}" alt="${escape(block.alt)}" loading="lazy"></figure>`;
  }
}
function searchIndex(model) {
  return model.pages.flatMap(page => {
    const normalize = value => value.replace(/\s+/g, ' ').trim();
    const entry = (title, hash, blocks) => ({ title, page: page.title, href: `${pageHref(page)}${hash}`, content: normalize(blocks.map(plainBlock).join(' ')) });
    return [entry(page.title, '', page.blocks), ...page.blocks.flatMap((block, index) => {
      if (block.type !== 'heading') return [];
      let end = index + 1;
      while (end < page.blocks.length && !(page.blocks[end].type === 'heading' && page.blocks[end].level <= block.level)) end++;
      return [entry(plainInline(block.content), `#${block.id}`, page.blocks.slice(index + 1, end))];
    })];
  });
}
function tutorial(model, page) {
  const pages = model.pages.filter(item => item.inPager);
  const position = pages.indexOf(page);
  if (position < 0 || pages.length < 2) return '';
  const previous = pages[position - 1];
  const next = pages[position + 1];
  return `<nav class="page-pager" aria-label="教程翻页">${previous ? `<a class="pager-previous" href="${pageHref(previous)}" rel="prev"><span>上一步</span><strong>← ${escape(label(previous))}</strong></a>` : ''}${next ? `<a class="pager-next" href="${pageHref(next)}" rel="next"><span>下一步</span><strong>${escape(label(next))} →</strong></a>` : ''}</nav>`;
}
function hero(model, page) {
  const title = `<h1>${escape(page.title)}</h1><p class="intro">${renderInline(page.blocks[0].content)}</p>`;
  if (page.kind !== 'home') {
    const promptIndex = page.kind === 'task' ? page.blocks.findIndex(block => block.type === 'code' && block.language === 'prompt') : -1;
    return `<div class="page-heading">${title}${promptIndex >= 0 ? `<a class="text-action" href="#editorial-code-${promptIndex}">查看操作提示词 <span aria-hidden="true">↓</span></a>` : ''}</div>`;
  }
  const tasks = model.pages.filter(item => item.inPager);
  const first = tasks[0];
  const maintenance = tasks.find(item => item.role === 'maintenance' && item !== first);
  return `<div class="home-hero"><div>${title}<div class="hero-actions">${first ? `<a class="button primary" href="${pageHref(first)}">${escape(label(first))}<span aria-hidden="true">↗</span></a>` : ''}${maintenance ? `<a class="text-action" href="${pageHref(maintenance)}">${escape(label(maintenance))} <span aria-hidden="true">→</span></a>` : ''}</div></div><div class="source-illustration" aria-hidden="true"><div class="mini-document"><div class="mini-title"><span class="mini-logo"></span><span class="mini-row long"></span></div><div class="mini-row long"></div><div class="mini-row"></div><div class="mini-rule"></div><div class="mini-toc"><i></i><div><span></span><span></span></div></div></div></div></div>${tasks.length ? `<section class="start-section" aria-labelledby="editorial-tasks"><h2 id="editorial-tasks">从一件具体的事开始</h2><div class="route-list">${tasks.map((task, index) => `<a href="${pageHref(task)}"><span class="route-number">${String(index + 1).padStart(2, '0')}</span><div><h3>${escape(label(task))}</h3><p>${escape(plainInline(task.blocks[0].content))}</p></div><span class="route-arrow" aria-hidden="true">↗</span></a>`).join('')}</div></section>` : ''}`;
}
function renderPage(model, page, index) {
  const home = model.pages.find(item => item.kind === 'home');
  const nav = navigation(model, page);
  const headings = page.blocks.filter(block => block.type === 'heading');
  const outline = headings.map(heading => `<a class="toc-level-${heading.level}" href="#${heading.id}">${escape(plainInline(heading.content))}</a>`).join('');
  const json = JSON.stringify(index).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const articleBody = [
    hero(model, page),
    ...page.blocks.slice(1).map((block, offset) => blockHtml(block, offset + 1)),
    tutorial(model, page),
  ].filter(Boolean).join('\n        ');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escape(plainInline(page.blocks[0].content))}">
  <title>${escape(page.title)} · ${escape(model.site.title)}</title>
  <link rel="icon" href="assets/editorial/mark.svg" type="image/svg+xml">
  <link rel="stylesheet" href="assets/editorial/style.css">
  <script src="assets/editorial/site.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#editorial-main">跳到正文</a>
  <header class="site-header">
    <a class="brand" href="${pageHref(home)}" aria-label="${escape(model.site.title)}首页"><img src="assets/editorial/mark.svg" width="30" height="30" alt=""><span>${escape(model.site.title)}</span></a>
    <div class="header-tools">
      <button class="search-trigger" id="editorial-search-toggle" aria-label="搜索文档" aria-controls="editorial-search-dialog" hidden>${searchIcon}<span>搜索文档</span><kbd>Ctrl K</kbd></button>
      <label class="theme-control" id="editorial-theme-control" hidden><span class="sr-only">外观</span><select id="editorial-theme" aria-label="外观"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
      <button class="mobile-menu" id="editorial-menu-toggle" aria-label="打开文档目录" aria-controls="editorial-mobile-nav" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg></button>
    </div>
  </header>
  <div class="layout">
    <aside class="sidebar" aria-label="文档导航区"><div class="project-label"><strong>${escape(model.site.title)}</strong><p>${escape(model.site.description)}</p></div><nav id="editorial-desktop-nav" aria-label="文档目录">${nav}</nav></aside>
    <main id="editorial-main" tabindex="-1">
      <div id="content" aria-hidden="true"></div>
      <details class="mobile-fallback" id="editorial-mobile-fallback"><summary>文档目录</summary><nav aria-label="窄屏文档目录">${nav}</nav></details>
      <div class="breadcrumb"><span>${escape(model.groups.find(group => group.id === page.group).title)}</span><span aria-hidden="true">/</span><span>${escape(label(page))}</span></div>
      <article id="${page.id}" class="page-${page.kind}">
        ${articleBody}
      </article>
      <footer class="article-footer"><span>${escape(model.site.title)}</span><a href="#editorial-main">返回页首 ↑</a></footer>
    </main>
    ${headings.length ? `<aside class="page-outline" aria-label="页内目录"><div class="outline-sticky"><p class="outline-label">本页内容</p><nav id="editorial-page-toc" aria-label="本页内容">${outline}</nav></div></aside>` : '<div class="outline-placeholder" aria-hidden="true"></div>'}
  </div>
  <dialog id="editorial-search-dialog" aria-labelledby="editorial-search-title">
    <div class="search-dialog-head">${searchIcon}<h2 id="editorial-search-title" class="sr-only">搜索文档</h2><input id="editorial-search-input" type="search" placeholder="搜索页面、章节与正文" autocomplete="off" aria-label="搜索页面、章节与正文"><button class="dialog-close" id="editorial-close-search" aria-label="关闭搜索">Esc</button></div>
    <p class="search-count" id="editorial-search-count" role="status"></p><div id="editorial-search-results"></div><p class="sr-only" id="editorial-search-active" aria-live="polite"></p><div class="search-help"><span>↑ ↓ 选择 · Enter 打开</span><span>Esc 关闭</span></div>
  </dialog>
  <dialog id="editorial-mobile-nav" aria-labelledby="editorial-menu-title"><div class="mobile-nav-head"><strong id="editorial-menu-title">文档目录</strong><button id="editorial-close-menu">关闭</button></div><nav aria-label="移动文档目录">${nav}</nav></dialog>
  <div class="toast" id="editorial-toast" role="status" aria-live="polite"></div>
  <script id="editorial-search-data" type="application/json">${json}</script>
</body>
</html>
`;
}

/**
 * @param {{site:{title:string,description:string,productKind:'plugin'|'library'},groups:{id:string,title:string}[],pages:Page[]}} input
 * @returns {{pages:{path:string,text:string}[],assets:{path:string,source:URL}[]}}
 * @throws {TypeError} Unsupported or unsafe domain input; caller owns exit codes.
 */
export function renderEditorialSite(input) {
  const model = normalize(input);
  const index = searchIndex(model);
  return {
    pages: model.pages.map(page => ({ path: pageHref(page), text: renderPage(model, page, index) })),
    assets: ['style.css', 'site.js', 'mark.svg'].map(name => ({ path: `assets/editorial/${name}`, source: new URL(`./assets/${name}`, import.meta.url) })),
  };
}
