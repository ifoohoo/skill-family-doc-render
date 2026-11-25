// SPDX-License-Identifier: Apache-2.0
// @feature DOC1 @scenario S-01 S-02
// Modern technical documentation design system template (Mintlify / Starlight inspired).
// Deterministic pure rendering with SHA-256 ?v=<sha8> content-fingerprint cache busting.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { highlightCode } from '../../scripts/lib/highlight.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const RESERVED_IDS = new Set(['content', 'editorial-main', 'doc-main']);

const escapeHtml = (value) => String(value).replace(/[&<>"'\r]/g, (ch) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '\r': '&#13;',
})[ch]);

const fail = (message) => {
  throw new TypeError(`modern template: ${message}`);
};

const sha8 = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 8);

const ASSET_FILES = ['theme.css', 'site.js', 'mark.svg'];

function readTemplateAssets() {
  return ASSET_FILES.map((name) => {
    const source = new URL(`./assets/${name}`, import.meta.url);
    const bytes = readFileSync(source);
    return { path: `assets/${name}`, source, bytes, hash8: sha8(bytes) };
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertNonEmptyString(value, at) {
  if (typeof value !== 'string' || !value.trim() || /\u0000/.test(value)) {
    fail(`${at} must be a nonempty string without NUL`);
  }
}

function assertSafeId(value, at) {
  if (typeof value !== 'string' || !ID.test(value) || value.startsWith('editorial-') || value.startsWith('doc-')) {
    fail(`${at}: invalid or reserved ID (${value})`);
  }
}

function validateHref(value, page, pages) {
  assertNonEmptyString(value, 'link.href');
  if (/[\s\\<>"'\u0000-\u001f\u007f]/u.test(value)) fail(`unsafe link: ${value}`);
  if (/^https?:\/\//.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      fail(`invalid external URL: ${value}`);
    }
    if (!url.hostname || url.username || url.password) fail(`invalid external URL: ${value}`);
    return;
  }
  if (/^mailto:[^@:?/#]+@[^@:?/#]+$/.test(value)) return;
  const match = /^(?:\.\/)?(?:([A-Za-z0-9][A-Za-z0-9_-]*)\.html)?(?:#([A-Za-z0-9][A-Za-z0-9_-]*))?$/.exec(value);
  if (!match || (!match[1] && !match[2])) {
    fail(`unsupported link: ${value}（仅支持 https/http/mailto 或站内 .html 与 #锚点相对路径）`);
  }
  const target = match[1] ? pages.get(match[1]) : page;
  if (!target || (match[2] && !target.anchors.has(match[2]))) {
    fail(`unresolved site link: ${value}（站内链接指向不存在的页面或章节锚点，请核对文件名与 {#id}）`);
  }
}

function validateAssetSrc(src, at) {
  assertNonEmptyString(src, at);
  if (
    !src.startsWith('assets/')
    || src.includes('..')
    || src.includes('%2e')
    || src.includes('%2E')
    || src.startsWith('assets/editorial/')
    || ['assets/theme.css', 'assets/site.js', 'assets/mark.svg', 'assets/search-index.json'].includes(src)
  ) {
    fail(`${at} must reference a contained asset inside assets/: ${src}`);
  }
}

function plainInline(content) {
  return (content || []).map((node) => {
    if (typeof node === 'string') return node;
    if (node.type === 'code' || node.type === 'kbd') return node.text;
    if (node.type === 'br') return ' ';
    if (node.type === 'image') return node.alt || '';
    return plainInline(node.content);
  }).join('');
}

function validateInline(content, page, pages, nestedLink = false) {
  if (!Array.isArray(content)) fail('inline content must be an array');
  for (const node of content) {
    if (typeof node === 'string') {
      if (/\u0000/.test(node)) fail('inline text cannot contain NUL');
      continue;
    }
    if (!isPlainObject(node)) fail('unsupported inline node');
    if (node.type === 'code' || node.type === 'kbd') {
      if (typeof node.text !== 'string' || /\u0000/.test(node.text)) fail('inline code/kbd text invalid');
    } else if (node.type === 'br') {
      // ok
    } else if (node.type === 'strong' || node.type === 'em' || node.type === 'del') {
      validateInline(node.content, page, pages, nestedLink);
    } else if (node.type === 'link') {
      if (nestedLink) fail('nested links are not supported');
      validateHref(node.href, page, pages);
      validateInline(node.content, page, pages, true);
      if (!plainInline(node.content).trim()) fail('link requires readable content');
    } else if (node.type === 'image') {
      validateAssetSrc(node.src, 'inline image.src');
    } else {
      fail(`unsupported inline node: ${node.type}`);
    }
  }
}

function validateBlocks(blocks, page, pages) {
  if (!Array.isArray(blocks)) fail('blocks must be an array');
  for (const block of blocks) {
    if (!isPlainObject(block)) fail('block must be an object');
    switch (block.type) {
      case 'paragraph':
        validateInline(block.content, page, pages);
        break;
      case 'heading':
        if (![2, 3, 4, 5].includes(block.level)) fail('heading.level must be 2–5');
        assertSafeId(block.id, 'heading.id');
        validateInline(block.content, page, pages);
        if (!plainInline(block.content).trim()) fail('heading requires readable content');
        break;
      case 'list':
        if (typeof block.ordered !== 'boolean') fail('list.ordered must be boolean');
        for (const item of block.items || []) {
          if (Array.isArray(item)) validateInline(item, page, pages);
          else validateBlocks(item.blocks || [], page, pages);
        }
        break;
      case 'table':
        for (const cell of block.headers || []) validateInline(cell, page, pages);
        for (const row of block.rows || []) {
          if (row.length !== block.headers.length) fail('table row width must match headers');
          for (const cell of row) validateInline(cell, page, pages);
        }
        break;
      case 'code':
        if (typeof block.language !== 'string' || !/^[a-z0-9][a-z0-9+#.-]*$/i.test(block.language)) {
          fail(`invalid code language: ${block.language}`);
        }
        if (typeof block.text !== 'string' || /\u0000/.test(block.text)) fail('code.text invalid');
        break;
      case 'callout':
        if (!['NOTE', 'TIP', 'INFO', 'WARNING', 'DANGER'].includes(block.tone)) {
          fail(`unsupported callout tone: ${block.tone}`);
        }
        if (block.title !== undefined && block.title !== null) {
          if (typeof block.title === 'string') {
            assertNonEmptyString(block.title, 'callout.title');
          } else {
            validateInline(block.title, page, pages);
            if (!plainInline(block.title).trim()) fail('callout.title requires readable content');
          }
        }
        if (block.blocks) validateBlocks(block.blocks, page, pages);
        else if (block.content) validateInline(block.content, page, pages);
        else fail('callout requires content or blocks');
        break;
      case 'blockquote':
        validateBlocks(block.blocks || [], page, pages);
        break;
      case 'hr':
        break;
      case 'image':
        validateAssetSrc(block.src, 'image.src');
        if (typeof block.alt !== 'string') fail('image.alt must be string');
        break;
      case 'diagram':
        validateAssetSrc(block.src, 'diagram.src');
        if (block.caption) validateBlocks(block.caption, page, pages);
        break;
      case 'tabs':
        for (const tab of block.tabs || []) {
          assertNonEmptyString(tab.label, 'tab.label');
          validateBlocks(tab.blocks || [], page, pages);
        }
        break;
      case 'cards':
        for (const card of block.cards || []) {
          assertNonEmptyString(card.title, 'card.title');
          if (card.href) validateHref(card.href, page, pages);
          validateBlocks(card.blocks || [], page, pages);
        }
        break;
      case 'steps':
        for (const step of block.steps || []) {
          if (step.title) validateInline(step.title, page, pages);
          validateBlocks(step.blocks || [], page, pages);
        }
        break;
      case 'file-tree':
        if (!Array.isArray(block.nodes) || !block.nodes.length) fail('file-tree requires nodes');
        break;
      default:
        fail(`unsupported content block: ${block.type}`);
    }
  }
}

function collectAnchors(blocks, anchors, label) {
  for (const block of blocks || []) {
    if (block.type === 'heading') {
      assertSafeId(block.id, 'heading.id');
      if (anchors.has(block.id)) fail(`${label}: duplicate anchor ID ${block.id}`);
      anchors.add(block.id);
    } else if (block.type === 'steps') {
      for (const step of block.steps || []) {
        if (step.id) {
          assertSafeId(step.id, 'step.id');
          if (anchors.has(step.id)) fail(`${label}: duplicate anchor ID ${step.id}`);
          anchors.add(step.id);
        }
        collectAnchors(step.blocks, anchors, label);
      }
    } else if (block.type === 'tabs') {
      for (const tab of block.tabs || []) collectAnchors(tab.blocks, anchors, label);
    } else if (block.type === 'cards') {
      for (const card of block.cards || []) collectAnchors(card.blocks, anchors, label);
    } else if (block.type === 'callout' || block.type === 'blockquote') {
      collectAnchors(block.blocks, anchors, label);
    }
  }
}

function normalizeModel(input) {
  if (!isPlainObject(input)) fail('model must be a plain object');
  if (!isPlainObject(input.site)) fail('site must be a plain object');
  assertNonEmptyString(input.site.title, 'site.title');
  const tagline = input.site.tagline || input.site.description || '';
  const version = input.site.version || '';

  const groups = Array.isArray(input.groups) && input.groups.length
    ? input.groups.map((g) => {
        assertSafeId(g.id, 'group.id');
        assertNonEmptyString(g.title, 'group.title');
        return { id: g.id, title: g.title };
      })
    : [{ id: 'docs', title: input.site.title }];

  const groupSet = new Set();
  for (const g of groups) {
    if (groupSet.has(g.id)) fail(`duplicate group ID: ${g.id}`);
    groupSet.add(g.id);
  }

  if (!Array.isArray(input.pages) || !input.pages.length) fail('pages must be a nonempty array');

  const rawPages = input.pages.map((p, index) => ({ ...p, _index: index }));
  const hasExplicitOrder = rawPages.every((p) => Number.isSafeInteger(p.order));
  const sorted = hasExplicitOrder
    ? [...rawPages].sort((a, b) => a.order - b.order)
    : [...rawPages].sort((a, b) => (a.order ?? a._index) - (b.order ?? b._index) || a._index - b._index);

  const pageMap = new Map();
  for (const page of sorted) {
    assertSafeId(page.id, 'page.id');
    if (RESERVED_IDS.has(page.id)) fail(`page.id uses reserved ID: ${page.id}`);
    assertNonEmptyString(page.title, 'page.title');
    if (pageMap.has(page.id)) fail(`duplicate page ID: ${page.id}`);
    const groupId = page.group || groups[0].id;
    if (!groupSet.has(groupId)) fail(`unknown page group: ${groupId}`);

    const anchors = new Set([page.id, 'content', 'doc-main']);
    collectAnchors(page.blocks || [], anchors, page.id);

    pageMap.set(page.id, {
      ...page,
      group: groupId,
      anchors,
    });
  }

  const pages = [...pageMap.values()];
  const home = pages.find((p) => p.kind === 'home') || pages.find((p) => p.id === 'index') || pages[0];

  const normalizedPages = pages.map((p) => {
    const isHome = p === home;
    const inPager = typeof p.inPager === 'boolean' ? p.inPager : true;
    return {
      ...p,
      isHome,
      inPager,
      summaryText: p.summary || firstParagraphText(p.blocks) || tagline || p.title,
    };
  });

  const normalizedMap = new Map(normalizedPages.map((p) => [p.id, p]));
  for (const page of normalizedPages) {
    validateBlocks(page.blocks || [], page, normalizedMap);
  }

  return {
    site: { title: input.site.title, tagline, version },
    groups,
    pages: normalizedPages,
    home: normalizedPages.find((p) => p.isHome),
    assetHashes: input.assetHashes || {},
  };
}

function firstParagraphText(blocks) {
  for (const block of blocks || []) {
    if (block.type === 'paragraph') {
      const text = plainInline(block.content).trim();
      if (text) return text;
    }
  }
  return '';
}

function plainBlocks(blocks) {
  const chunks = [];
  for (const block of blocks || []) {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
        chunks.push(plainInline(block.content));
        break;
      case 'list':
        for (const item of block.items || []) {
          if (Array.isArray(item)) chunks.push(plainInline(item));
          else chunks.push(plainBlocks(item.blocks));
        }
        break;
      case 'table':
        chunks.push(...(block.headers || []).map(plainInline));
        for (const row of block.rows || []) chunks.push(...row.map(plainInline));
        break;
      case 'code':
        chunks.push(block.text);
        break;
      case 'callout':
        if (block.title) {
          chunks.push(typeof block.title === 'string' ? block.title : plainInline(block.title));
        }
        chunks.push(block.blocks ? plainBlocks(block.blocks) : plainInline(block.content));
        break;
      case 'blockquote':
        chunks.push(plainBlocks(block.blocks));
        break;
      case 'image':
        chunks.push(block.alt || '');
        break;
      case 'diagram':
        chunks.push(block.title || block.alt || '');
        if (block.caption) chunks.push(plainBlocks(block.caption));
        break;
      case 'tabs':
        for (const tab of block.tabs || []) {
          chunks.push(tab.label, plainBlocks(tab.blocks));
        }
        break;
      case 'cards':
        for (const card of block.cards || []) {
          chunks.push(card.title, plainBlocks(card.blocks));
        }
        break;
      case 'steps':
        for (const step of block.steps || []) {
          if (step.title) chunks.push(plainInline(step.title));
          chunks.push(plainBlocks(step.blocks));
        }
        break;
      case 'file-tree': {
        const walk = (nodes) => {
          for (const node of nodes || []) {
            chunks.push(node.name, node.comment || '');
            walk(node.children);
          }
        };
        walk(block.nodes);
        break;
      }
      default:
        break;
    }
  }
  return chunks.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function collectTocHeadings(blocks, out = []) {
  for (const block of blocks || []) {
    if (block.type === 'heading' && block.level <= 4) {
      out.push({ id: block.id, level: block.level, title: plainInline(block.content) });
    } else if (block.type === 'steps') {
      for (const step of block.steps || []) {
        if (step.id && step.title && (step.level || 3) <= 4) {
          out.push({ id: step.id, level: step.level || 3, title: plainInline(step.title) });
        }
        collectTocHeadings(step.blocks, out);
      }
    }
  }
  return out;
}

function buildSearchIndex(model) {
  return model.pages.flatMap((page) => {
    const pageEntry = {
      title: page.title,
      page: page.navTitle || page.title,
      href: `${page.id}.html`,
      summary: page.summaryText,
      content: `${page.summaryText} ${plainBlocks(page.blocks || [])}`.replace(/\s+/g, ' ').trim(),
    };
    const sectionEntries = [];
    const blocks = page.blocks || [];
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      if (block.type === 'heading') {
        let end = i + 1;
        while (end < blocks.length && !(blocks[end].type === 'heading' && blocks[end].level <= block.level)) {
          end += 1;
        }
        sectionEntries.push({
          title: plainInline(block.content),
          page: page.navTitle || page.title,
          href: `${page.id}.html#${block.id}`,
          content: plainBlocks(blocks.slice(i + 1, end)),
        });
      } else if (block.type === 'steps') {
        for (const step of block.steps || []) {
          if (step.id && step.title) {
            sectionEntries.push({
              title: plainInline(step.title),
              page: page.navTitle || page.title,
              href: `${page.id}.html#${step.id}`,
              content: plainBlocks(step.blocks),
            });
          }
        }
      }
    }
    return [pageEntry, ...sectionEntries];
  });
}

function versionedUrl(path, assetHashes) {
  const hash8 = assetHashes[path];
  return hash8 ? `${path}?v=${hash8}` : path;
}

function normalizeTabKey(label) {
  const lower = String(label || '').trim().toLowerCase();
  if (/^claude/.test(lower)) return 'claude-code';
  if (/^codex/.test(lower)) return 'codex';
  if (/^kimi/.test(lower)) return 'kimi';
  if (/^workbuddy|^codebuddy/.test(lower)) return 'workbuddy';
  if (/^antigravity/.test(lower)) return 'antigravity';
  return lower.replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '-').replace(/^-+|-+$/g, '') || 'tab';
}

const ICONS = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>',
  sun: '<svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"></path></svg>',
  moon: '<svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"></path></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg>',
  folder: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.4l1.5 1.8H16A1.5 1.5 0 0 1 17.5 7.3v7.2A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5V5.5Z"></path></svg>',
  file: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3.5h6.5L15.5 7.5v9A1.5 1.5 0 0 1 14 18H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5Z"></path><path d="M11.5 3.5v4h4"></path></svg>',
  rocket: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09Z"></path><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2Z"></path></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"></path><path d="m9 12 2 2 4-4"></path></svg>',
  sparkles: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"></path><path d="M19 3v4M21 5h-4"></path></svg>',
  terminal: '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>',
  layers: '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 12 12 17 22 12"></polyline><polyline points="2 17 12 22 22 17"></polyline></svg>',
  book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"></path></svg>',
  wrench: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"></path></svg>',
  zap: '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>',
  compass: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="m9 12 2 2 4-4"></path></svg>',
};

const CALLOUT_META = {
  TIP: { cls: 'tip', label: '建议', icon: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5"></circle><path d="m6.8 10.2 2.1 2.1 4.4-4.5"></path></svg>' },
  INFO: { cls: 'info', label: '说明', icon: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5"></circle><path d="M10 9v4.5M10 6.5h.01"></path></svg>' },
  NOTE: { cls: 'info', label: '说明', icon: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5"></circle><path d="M10 9v4.5M10 6.5h.01"></path></svg>' },
  WARNING: { cls: 'warning', label: '注意', icon: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.7 3.8a1.5 1.5 0 0 1 2.6 0l5.9 10.4a1.5 1.5 0 0 1-1.3 2.3H4.1a1.5 1.5 0 0 1-1.3-2.3L8.7 3.8Z"></path><path d="M10 8v3.6M10 14.2h.01"></path></svg>' },
  DANGER: { cls: 'danger', label: '警示', icon: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5"></circle><path d="M10 6.5v4.5M10 13.8h.01"></path></svg>' },
};

function renderPage(model, page, templateHashes, searchHash8) {
  const nav = model.groups.map((group) => {
    const groupPages = model.pages.filter((p) => p.group === group.id);
    if (!groupPages.length) return '';
    return `<div class="nav-group"><p class="nav-group-title">${escapeHtml(group.title)}</p>${groupPages.map((item) => `<a class="nav-link" href="${item.id}.html"${item === page ? ' aria-current="page"' : ''}>${escapeHtml(item.navTitle || item.title)}</a>`).join('')}</div>`;
  }).join('');

  let codeCounter = 0;
  let tabGroupCounter = 0;

  function renderInline(content) {
    return (content || []).map((node) => {
      if (typeof node === 'string') return escapeHtml(node);
      if (node.type === 'code') return `<code>${escapeHtml(node.text)}</code>`;
      if (node.type === 'kbd') return `<kbd>${escapeHtml(node.text)}</kbd>`;
      if (node.type === 'br') return '<br>';
      if (node.type === 'image') {
        return `<img src="${escapeHtml(versionedUrl(node.src, model.assetHashes))}" alt="${escapeHtml(node.alt || '')}" loading="lazy">`;
      }
      if (node.type === 'link') {
        const titleAttr = node.title ? ` title="${escapeHtml(node.title)}"` : '';
        return `<a href="${escapeHtml(node.href)}"${titleAttr}>${renderInline(node.content)}</a>`;
      }
      return `<${node.type}>${renderInline(node.content)}</${node.type}>`;
    }).join('');
  }

  function renderFileTreeNodes(nodes) {
    return `<ul>${nodes.map((node) => {
      const icon = node.isDir ? ICONS.folder : ICONS.file;
      const comment = node.comment ? `<span class="tree-comment">${escapeHtml(node.comment)}</span>` : '';
      const children = node.children?.length ? renderFileTreeNodes(node.children) : '';
      return `<li><div class="tree-row"><span class="tree-name${node.isDir ? ' is-dir' : ''}">${icon}<span>${escapeHtml(node.name)}</span></span>${comment}</div>${children}</li>`;
    }).join('')}</ul>`;
  }

  function renderBlocks(blocks, { compactSinglePara = false } = {}) {
    if (compactSinglePara && blocks.length === 1 && blocks[0].type === 'paragraph') {
      return renderInline(blocks[0].content);
    }
    return blocks.map((block) => renderBlock(block)).join('\n');
  }

  function renderBlock(block) {
    switch (block.type) {
      case 'paragraph':
        return `<p>${renderInline(block.content)}</p>`;
      case 'heading': {
        return `<h${block.level} id="${block.id}" tabindex="-1">${renderInline(block.content)}<a class="heading-anchor" href="#${block.id}" data-copy-link="${block.id}" aria-label="复制本节链接" title="复制链接">#</a></h${block.level}>`;
      }
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        const startAttr = block.ordered && block.start && block.start !== 1 ? ` start="${block.start}"` : '';
        return `<${tag}${startAttr}>${block.items.map((item) => {
          if (Array.isArray(item)) return `<li>${renderInline(item)}</li>`;
          const isTask = typeof item.checked === 'boolean';
          const cls = isTask ? ' class="task-item"' : '';
          const checkbox = isTask ? `<input type="checkbox"${item.checked ? ' checked' : ''} disabled aria-label="任务状态">` : '';
          return `<li${cls}>${checkbox}${renderBlocks(item.blocks, { compactSinglePara: true })}</li>`;
        }).join('')}</${tag}>`;
      }
      case 'table': {
        const alignAttr = (idx) => {
          const al = block.align?.[idx];
          return al ? ` style="text-align: ${al}"` : '';
        };
        const head = block.headers.map((cell, idx) => `<th scope="col"${alignAttr(idx)}>${renderInline(cell)}</th>`).join('');
        const body = block.rows.map((row) => `<tr>${row.map((cell, idx) => `<td${alignAttr(idx)}>${renderInline(cell)}</td>`).join('')}</tr>`).join('');
        return `<div class="table-scroll" role="region" tabindex="0" aria-label="内容表格"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
      }
      case 'code': {
        const codeId = `doc-code-${codeCounter}`;
        codeCounter += 1;
        const lang = block.language.toLowerCase();
        if (lang === 'prompt') {
          const title = block.title || '发给 AI 助手的对话提示词';
          return `<div class="prompt-card"><div class="prompt-head"><span class="prompt-badge"><span aria-hidden="true">💬</span><span>${escapeHtml(title)}</span></span><button class="copy-btn" type="button" data-copy="${codeId}" hidden>复制提示词</button></div><pre tabindex="0"><code id="${codeId}">${escapeHtml(block.text)}</code></pre></div>`;
        }
        return `<div class="code-card"><div class="code-head"><span class="code-lang">${escapeHtml(block.language)}</span><button class="copy-btn" type="button" data-copy="${codeId}" hidden>复制代码</button></div><pre tabindex="0"><code id="${codeId}">${highlightCode(lang, block.text)}</code></pre></div>`;
      }
      case 'callout': {
        const meta = CALLOUT_META[block.tone] || CALLOUT_META.INFO;
        const titleHtml = Array.isArray(block.title)
          ? renderInline(block.title)
          : escapeHtml(block.title || meta.label);
        const body = block.blocks ? renderBlocks(block.blocks) : `<p>${renderInline(block.content)}</p>`;
        return `<aside class="callout ${meta.cls}"><span class="callout-icon" aria-hidden="true">${meta.icon}</span><div class="callout-body"><strong class="callout-title">${titleHtml}</strong>${body}</div></aside>`;
      }
      case 'blockquote':
        return `<blockquote class="doc-blockquote">${renderBlocks(block.blocks)}</blockquote>`;
      case 'hr':
        return '<hr class="doc-divider">';
      case 'image': {
        const src = versionedUrl(block.src, model.assetHashes);
        const cap = block.alt ? `<figcaption>${escapeHtml(block.alt)}</figcaption>` : '';
        return `<figure class="doc-figure"><img src="${escapeHtml(src)}" alt="${escapeHtml(block.alt)}" loading="lazy">${cap}</figure>`;
      }
      case 'diagram': {
        const src = versionedUrl(block.src, model.assetHashes);
        const isHtml = block.src.toLowerCase().endsWith('.html');
        const height = block.height || 440;
        const title = block.title || block.alt || '架构示意图';
        const body = isHtml
          ? `<iframe class="diagram-embed" src="${escapeHtml(src)}" title="${escapeHtml(title)}" loading="lazy" sandbox="allow-scripts" style="height: min(${height}px, 72vh)"></iframe>`
          : `<img src="${escapeHtml(src)}" alt="${escapeHtml(block.alt || title)}" loading="lazy">`;
        const caption = block.caption ? `<figcaption class="diagram-caption">${renderBlocks(block.caption)}</figcaption>` : '';
        return `<figure class="diagram-frame"><div class="diagram-head"><span class="diagram-title">${escapeHtml(title)}</span><div class="diagram-actions"><button class="diagram-action-btn" type="button" data-diagram-expand="${escapeHtml(src)}" data-diagram-kind="${isHtml ? 'html' : 'svg'}" data-diagram-title="${escapeHtml(title)}" hidden>放大查看</button><a class="diagram-action-btn" href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer">新窗口打开 ↗</a></div></div><div class="diagram-body">${body}</div>${caption}</figure>`;
      }
      case 'tabs': {
        const groupIdx = tabGroupCounter;
        tabGroupCounter += 1;
        const syncAttr = block.sync ? ` data-sync="${escapeHtml(block.sync)}"` : '';
        const syncBadge = block.sync === 'host'
          ? '<span class="tabs-sync-badge">全站同步当前宿主</span>'
          : (block.sync ? `<span class="tabs-sync-badge">全站同步</span>` : '');
        const buttons = block.tabs.map((tab, idx) => {
          const key = normalizeTabKey(tab.label);
          const tabId = `doc-tab-btn-${groupIdx}-${idx}`;
          const panelId = `doc-tab-panel-${groupIdx}-${idx}`;
          return `<button class="tab-btn" type="button" role="tab" id="${tabId}" aria-controls="${panelId}" aria-selected="${idx === 0 ? 'true' : 'false'}" tabindex="${idx === 0 ? '0' : '-1'}" data-tab-key="${escapeHtml(key)}">${escapeHtml(tab.label)}</button>`;
        }).join('');
        const panels = block.tabs.map((tab, idx) => {
          const key = normalizeTabKey(tab.label);
          const tabId = `doc-tab-btn-${groupIdx}-${idx}`;
          const panelId = `doc-tab-panel-${groupIdx}-${idx}`;
          return `<div class="tabs-panel" role="tabpanel" id="${panelId}" aria-labelledby="${tabId}" data-tab-key="${escapeHtml(key)}"${idx === 0 ? '' : ' hidden'}><p class="tabs-panel-fallback-label">${escapeHtml(tab.label)}</p>${renderBlocks(tab.blocks)}</div>`;
        }).join('');
        return `<div class="doc-tabs" data-tabs${syncAttr}><div class="tabs-bar"><div class="tabs-list" role="tablist">${buttons}</div>${syncBadge}</div><div class="tabs-panels">${panels}</div></div>`;
      }
      case 'cards': {
        return `<div class="doc-cards">${block.cards.map((card) => {
          const iconSvg = card.icon && ICONS[card.icon] ? `<span class="doc-card-icon" aria-hidden="true">${ICONS[card.icon]}</span>` : '';
          const badge = card.badge ? `<span class="doc-card-badge">${escapeHtml(card.badge)}</span>` : '';
          const head = (iconSvg || badge) ? `<div class="doc-card-head">${iconSvg}${badge}</div>` : '';
          const arrow = card.href ? '<span class="doc-card-arrow" aria-hidden="true">↗</span>' : '';
          const inner = `${head}<h3 class="doc-card-title"><span>${escapeHtml(card.title)}</span>${arrow}</h3><div class="doc-card-body">${renderBlocks(card.blocks)}</div>`;
          if (card.href) return `<a class="doc-card is-link" href="${escapeHtml(card.href)}">${inner}</a>`;
          return `<div class="doc-card">${inner}</div>`;
        }).join('')}</div>`;
      }
      case 'steps': {
        return `<ol class="doc-steps">${block.steps.map((step, idx) => {
          const titleHtml = step.title
            ? `<h${step.level || 3} class="step-title"${step.id ? ` id="${step.id}" tabindex="-1"` : ''}>${renderInline(step.title)}</h${step.level || 3}>`
            : '';
          return `<li class="doc-step"><span class="step-num" aria-hidden="true">${idx + 1}</span><div class="step-body">${titleHtml}${renderBlocks(step.blocks)}</div></li>`;
        }).join('')}</ol>`;
      }
      case 'file-tree':
        return `<div class="file-tree" role="region" aria-label="目录结构">${renderFileTreeNodes(block.nodes)}</div>`;
      default:
        return '';
    }
  }

  const tocHeadings = collectTocHeadings(page.blocks || []);
  const outlineHtml = tocHeadings.length
    ? `<aside class="page-outline" aria-label="页内目录"><p class="outline-label">本页内容</p><nav class="outline-nav" id="doc-page-toc" aria-label="本页内容">${tocHeadings.map((h) => `<a class="toc-level-${h.level}" href="#${h.id}">${escapeHtml(h.title)}</a>`).join('')}</nav></aside>`
    : '<div class="outline-placeholder" aria-hidden="true"></div>';

  const pagerPages = model.pages.filter((p) => p.inPager);
  const pos = pagerPages.indexOf(page);
  let pagerHtml = '';
  if (pos >= 0 && pagerPages.length >= 2) {
    const prev = pagerPages[pos - 1];
    const next = pagerPages[pos + 1];
    pagerHtml = `<nav class="page-pager" aria-label="文档翻页">${prev ? `<a class="pager-link is-prev" href="${prev.id}.html" rel="prev"><span class="pager-dir">← 上一篇</span><span class="pager-title">${escapeHtml(prev.navTitle || prev.title)}</span></a>` : ''}${next ? `<a class="pager-link is-next" href="${next.id}.html" rel="next"><span class="pager-dir">下一篇 →</span><span class="pager-title">${escapeHtml(next.navTitle || next.title)}</span></a>` : ''}</nav>`;
  }

  const groupTitle = model.groups.find((g) => g.id === page.group)?.title || model.site.title;
  const versionBadge = model.site.version ? `<span class="version-pill">v${escapeHtml(model.site.version.replace(/^v/i, ''))}</span>` : '';
  const summaryHtml = page.summary ? `<p class="page-summary">${escapeHtml(page.summary)}</p>` : '';

  return `<!doctype html>
<html lang="zh-CN" data-search-index="assets/search-index.json?v=${searchHash8}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(page.summaryText)}">
  <title>${escapeHtml(page.title)} · ${escapeHtml(model.site.title)}</title>
  <link rel="icon" href="assets/mark.svg?v=${templateHashes['assets/mark.svg']}" type="image/svg+xml">
  <link rel="stylesheet" href="assets/theme.css?v=${templateHashes['assets/theme.css']}">
  <script src="assets/site.js?v=${templateHashes['assets/site.js']}" defer></script>
</head>
<body>
  <a class="skip-link" href="#doc-main">跳到正文</a>
  <header class="site-header">
    <div class="header-inner">
      <div class="header-left">
        <button class="icon-btn mobile-menu-btn" id="doc-menu-toggle" type="button" aria-label="打开导航目录" aria-controls="doc-mobile-nav" hidden>${ICONS.menu}</button>
        <a class="brand" href="${model.home.id}.html" aria-label="${escapeHtml(model.site.title)}首页">
          <img src="assets/mark.svg?v=${templateHashes['assets/mark.svg']}" width="28" height="28" alt="">
          <span class="brand-title">${escapeHtml(model.site.title)}</span>
        </a>
        ${versionBadge}
      </div>
      <div class="header-tools">
        <button class="search-trigger" id="doc-search-toggle" type="button" aria-label="搜索文档" aria-controls="doc-search-dialog" hidden>${ICONS.search}<span class="search-trigger-text">搜索文档…</span><kbd>Ctrl K</kbd></button>
        <button class="icon-btn" id="doc-theme-toggle" type="button" aria-label="切换浅色或深色主题" hidden>${ICONS.sun}${ICONS.moon}</button>
      </div>
    </div>
  </header>
  <div class="doc-shell">
    <aside class="sidebar" aria-label="文档目录">
      ${model.site.tagline ? `<p class="sidebar-summary">${escapeHtml(model.site.tagline)}</p>` : ''}
      <nav id="doc-desktop-nav" aria-label="文档导航">${nav}</nav>
    </aside>
    <main id="doc-main" class="doc-main" tabindex="-1">
      <div id="content" aria-hidden="true"></div>
      <details class="mobile-fallback" id="doc-mobile-fallback">
        <summary>文档目录</summary>
        <nav aria-label="窄屏文档目录">${nav}</nav>
      </details>
      <article id="${page.id}" class="doc-article">
        <header class="page-header">
          <div class="breadcrumb"><span>${escapeHtml(groupTitle)}</span><span aria-hidden="true">/</span><span>${escapeHtml(page.navTitle || page.title)}</span></div>
          <h1>${escapeHtml(page.title)}</h1>
          ${summaryHtml}
        </header>
        ${renderBlocks(page.blocks || [])}
        ${pagerHtml}
      </article>
      <footer class="article-footer">
        <span>${escapeHtml(model.site.title)}</span>
        <a href="#doc-main">返回页首 ↑</a>
      </footer>
    </main>
    ${outlineHtml}
  </div>
  <dialog class="doc-dialog" id="doc-search-dialog" aria-labelledby="doc-search-title">
    <div class="search-dialog-head">${ICONS.search}<h2 id="doc-search-title" class="sr-only">搜索文档</h2><input id="doc-search-input" type="search" placeholder="搜索文档、命令、组件或关键字…" autocomplete="off" aria-label="搜索文档"><button class="dialog-close" id="doc-close-search" type="button" aria-label="关闭搜索">Esc</button></div>
    <p class="search-count" id="doc-search-count" role="status"></p>
    <div class="search-results" id="doc-search-results"></div>
    <p class="sr-only" id="doc-search-active" aria-live="polite"></p>
    <div class="search-help"><span>↑ ↓ 选择 · Enter 跳转</span><span>Esc 关闭</span></div>
  </dialog>
  <dialog class="mobile-nav-dialog" id="doc-mobile-nav" aria-labelledby="doc-menu-title">
    <div class="mobile-nav-head"><strong id="doc-menu-title">${escapeHtml(model.site.title)}</strong><button class="dialog-close" id="doc-close-menu" type="button">关闭</button></div>
    <nav class="mobile-nav-body" aria-label="移动端文档目录">${nav}</nav>
  </dialog>
  <dialog class="diagram-dialog" id="doc-diagram-dialog" aria-labelledby="doc-diagram-dialog-title">
    <div class="diagram-dialog-head"><strong id="doc-diagram-dialog-title">图表预览</strong><button class="dialog-close" id="doc-close-diagram" type="button">关闭</button></div>
    <div class="diagram-dialog-body" id="doc-diagram-dialog-body"></div>
  </dialog>
  <div class="toast" id="doc-toast" role="status" aria-live="polite"></div>
</body>
</html>
`;
}

/**
 * @param {object} input
 * @returns {{pages:{path:string,text:string}[],assets:{path:string,source?:URL,bytes:Buffer}[]}}
 */
export function renderModernSite(input) {
  const model = normalizeModel(input);
  const templateAssets = readTemplateAssets();
  const templateHashes = Object.fromEntries(templateAssets.map((a) => [a.path, a.hash8]));

  const searchEntries = buildSearchIndex(model);
  const searchBytes = Buffer.from(JSON.stringify(searchEntries), 'utf8');
  const searchHash8 = sha8(searchBytes);

  const pages = model.pages.map((page) => ({
    path: `${page.id}.html`,
    text: renderPage(model, page, templateHashes, searchHash8),
  }));

  const assets = [
    ...templateAssets.map(({ path, source, bytes }) => ({ path, source, bytes })),
    { path: 'assets/search-index.json', bytes: searchBytes },
  ];

  return { pages, assets };
}

export { renderModernSite as renderEditorialSite };
