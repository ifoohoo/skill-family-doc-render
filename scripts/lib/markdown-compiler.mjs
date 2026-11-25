// SPDX-License-Identifier: Apache-2.0
// @feature DOC1 @scenario S-01 S-02
// doc-render v2 现代 Markdown 编译内核：
// 支持完整 GFM（多级嵌套列表、任务列表、表格对齐、删除线、普通引用块、分隔线、引用式链接）、
// 稳定 {#id} 锚点与自动语义 slug，以及 6 大 AI 技能族原生容器组件：
//   1) ::: tabs [sync="..."] + ::: tab <label>
//   2) ```prompt / ::: prompt 与多语言静态高亮代码块
//   3) ::: steps
//   4) ::: cards + ::: card title="..." href="..." icon="..."
//   5) ::: file-tree
//   6) ::: tip / info / note / warning / danger（含 GFM [!TIP] 等）与 ::: diagram src="..."

import { Lexer } from 'marked';

const TOKEN = /@[A-Z0-9_]+@/g;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SAFE_ASSET_EXT = /\.(?:svg|png|jpe?g|webp|html)$/i;

export class MarkdownCompileError extends TypeError {
  constructor(message) {
    super(`markdown: ${message}`);
  }
}

export { MarkdownCompileError as MarkdownV1Error };

const fail = (message) => {
  throw new MarkdownCompileError(message);
};

/** Replace configured facts as literal data, never as Markdown syntax. */
export function replaceMarkdownTokens(value, tokens = {}, label = 'text') {
  if (typeof value !== 'string') fail(`${label} must be a string（须为字符串）`);
  const replaced = value.replace(TOKEN, (match) => (
    Object.hasOwn(tokens, match) ? String(tokens[match]) : match
  ));
  const residual = replaced.match(TOKEN);
  if (residual) {
    fail(`${label} contains unresolved token(s): ${[...new Set(residual)].join(', ')}（存在未替换占位符，请在 public-release.json 的 tokens 或 versionSources 中声明）`);
  }
  return replaced;
}

function explicitHeading(token) {
  const match = /^(.*\S)\s+\{#([A-Za-z0-9][A-Za-z0-9_-]*)\}\s*$/.exec(token.text);
  if (!match) {
    if (/\s+\{[^}]*\}\s*$/.test(token.text)) {
      fail('heading contains an unsupported or invalid attribute extension（标题仅支持末尾 {#id} 稳定锚点语法，不支持其他属性）');
    }
    return null;
  }
  return { title: match[1], id: match[2] };
}

function slug(title) {
  const value = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return value || 'section';
}

function isCommentOnlyHtml(raw) {
  const stripped = String(raw || '').replace(/<!--[\s\S]*?-->/g, '').trim();
  return stripped.length === 0;
}

function parseInlineSafeHtml(raw, label) {
  const trimmed = String(raw || '').trim();
  if (!trimmed || isCommentOnlyHtml(trimmed)) return [];
  if (/^<br\s*\/?>$/i.test(trimmed)) return [{ type: 'br' }];
  const kbd = /^<kbd>([\s\S]*?)<\/kbd>$/i.exec(trimmed);
  if (kbd && !/[<>]/.test(kbd[1])) return [{ type: 'kbd', text: kbd[1] }];
  fail(`${label} raw HTML is not supported（不支持内嵌原始 HTML，请改用 Markdown 或 ::: 容器语法）`);
}

function parseDirectiveAttrs(raw, label, lineNo) {
  const attrs = {};
  let rest = raw.trim();
  const attrRe = /^([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/;
  while (rest.length > 0) {
    const match = attrRe.exec(rest);
    if (!match) {
      fail(`${label} 第 ${lineNo} 行指令属性格式无效: ${rest}`);
    }
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
    rest = rest.slice(match[0].length).trimStart();
  }
  return attrs;
}

function stripOuterQuotes(value) {
  const s = value.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseFileTree(lines, tokens, label, startLine) {
  const items = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const match = /^(\s*)(?:[-*+]|\d+\.)\s+(.+?)\s*$/.exec(raw);
    if (!match) {
      fail(`${label} 第 ${startLine + i} 行 ::: file-tree 须使用缩进列表条目（如 - dir/ # 说明）`);
    }
    const indent = match[1].replace(/\t/g, '  ').length;
    let body = match[2].trim();
    let comment = '';
    const commentMatch = /^(.*?)\s+#\s*(.*)$/.exec(body);
    if (commentMatch) {
      body = commentMatch[1].trim();
      comment = commentMatch[2].trim();
    }
    const name = replaceMarkdownTokens(body, tokens, `${label} file-tree`);
    const resolvedComment = comment ? replaceMarkdownTokens(comment, tokens, `${label} file-tree comment`) : '';
    const isDir = name.endsWith('/');
    items.push({
      indent,
      node: {
        name,
        isDir,
        ...(resolvedComment ? { comment: resolvedComment } : {}),
        children: [],
      },
    });
  }
  const roots = [];
  const stack = [];
  for (const entry of items) {
    while (stack.length > 0 && stack.at(-1).indent >= entry.indent) stack.pop();
    if (stack.length === 0) roots.push(entry.node);
    else {
      stack.at(-1).node.isDir = true;
      stack.at(-1).node.children.push(entry.node);
    }
    stack.push(entry);
  }
  return roots;
}

function parseContainerTree(source, label) {
  const lines = source.split(/\r?\n/);
  const root = { kind: 'root', children: [] };
  const stack = [{ node: root, lines: [], openLine: 1 }];
  let fenceChar = null;
  let fenceLen = 0;

  const flushLines = (frame) => {
    if (!frame.lines.length) return;
    const text = frame.lines.join('\n');
    frame.lines = [];
    if (text.trim()) frame.node.children.push({ kind: 'markdown', text, line: frame.openLine });
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const lineNo = idx + 1;
    const line = lines[idx];
    const current = stack.at(-1);

    // file-tree 与 prompt 内部原样保留文本，直到遇见顶层闭合 :::
    if (current.node.kind === 'prompt' || current.node.kind === 'file-tree') {
      if (current.node.kind === 'prompt') {
        if (!fenceChar) {
          const openFence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
          if (openFence && !(openFence[1][0] === '`' && openFence[2].includes('`'))) {
            fenceChar = openFence[1][0];
            fenceLen = openFence[1].length;
            current.lines.push(line);
            continue;
          }
        } else {
          const closeFence = new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`);
          if (closeFence.test(line)) {
            fenceChar = null;
            fenceLen = 0;
          }
          current.lines.push(line);
          continue;
        }
      }
      if (/^\s*:::\s*$/.test(line)) {
        current.node.rawLines = current.lines;
        stack.pop();
        continue;
      }
      current.lines.push(line);
      continue;
    }

    if (!fenceChar) {
      const openFence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (openFence && !(openFence[1][0] === '`' && openFence[2].includes('`'))) {
        fenceChar = openFence[1][0];
        fenceLen = openFence[1].length;
        current.lines.push(line);
        continue;
      }
    } else {
      const closeFence = new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`);
      if (closeFence.test(line)) {
        fenceChar = null;
        fenceLen = 0;
      }
      current.lines.push(line);
      continue;
    }

    const dirMatch = /^\s*:::(.*)$/.exec(line);
    if (!dirMatch) {
      current.lines.push(line);
      continue;
    }

    const rest = dirMatch[1].trim();
    if (!rest) {
      if (stack.length <= 1) {
        fail(`${label} 第 ${lineNo} 行存在多余的 ::: 结束标记`);
      }
      flushLines(current);
      stack.pop();
      continue;
    }

    const selfClosing = rest.endsWith(':::');
    const header = selfClosing ? rest.slice(0, -3).trim() : rest;
    const headMatch = /^([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(header);
    if (!headMatch) {
      fail(`${label} 第 ${lineNo} 行容器语法无效: ::: ${rest}`);
    }
    const kind = headMatch[1].toLowerCase();
    const argsRaw = (headMatch[2] || '').trim();

    if (kind === 'tab' && stack.at(-1).node.kind === 'tab') {
      flushLines(stack.at(-1));
      stack.pop();
    } else if (kind === 'card' && stack.at(-1).node.kind === 'card') {
      flushLines(stack.at(-1));
      stack.pop();
    }

    const parentFrame = stack.at(-1);
    flushLines(parentFrame);

    if (kind === 'tabs') {
      const attrs = argsRaw ? parseDirectiveAttrs(argsRaw, label, lineNo) : {};
      const node = { kind: 'tabs', sync: attrs.sync || null, children: [], line: lineNo };
      parentFrame.node.children.push(node);
      stack.push({ node, lines: [], openLine: lineNo });
    } else if (kind === 'tab') {
      if (parentFrame.node.kind !== 'tabs') {
        fail(`${label} 第 ${lineNo} 行 ::: tab 必须写在 ::: tabs 容器内部`);
      }
      const tabLabel = stripOuterQuotes(argsRaw);
      if (!tabLabel) fail(`${label} 第 ${lineNo} 行 ::: tab 缺少标签名`);
      const node = { kind: 'tab', label: tabLabel, children: [], line: lineNo };
      parentFrame.node.children.push(node);
      stack.push({ node, lines: [], openLine: lineNo });
    } else if (kind === 'cards') {
      const node = { kind: 'cards', children: [], line: lineNo };
      parentFrame.node.children.push(node);
      stack.push({ node, lines: [], openLine: lineNo });
    } else if (kind === 'card') {
      if (parentFrame.node.kind !== 'cards') {
        fail(`${label} 第 ${lineNo} 行 ::: card 必须写在 ::: cards 容器内部`);
      }
      const attrs = argsRaw ? parseDirectiveAttrs(argsRaw, label, lineNo) : {};
      if (!attrs.title) fail(`${label} 第 ${lineNo} 行 ::: card 必须提供 title="..." 属性`);
      const node = {
        kind: 'card',
        title: attrs.title,
        href: attrs.href || null,
        icon: attrs.icon || null,
        badge: attrs.badge || null,
        children: [],
        line: lineNo,
      };
      parentFrame.node.children.push(node);
      stack.push({ node, lines: [], openLine: lineNo });
    } else if (kind === 'steps') {
      const node = { kind: 'steps', children: [], line: lineNo };
      parentFrame.node.children.push(node);
      stack.push({ node, lines: [], openLine: lineNo });
    } else if (kind === 'file-tree') {
      const node = { kind: 'file-tree', rawLines: [], line: lineNo };
      parentFrame.node.children.push(node);
      stack.push({ node, lines: [], openLine: lineNo });
    } else if (kind === 'prompt') {
      const node = { kind: 'prompt', title: stripOuterQuotes(argsRaw) || null, rawLines: [], line: lineNo };
      parentFrame.node.children.push(node);
      stack.push({ node, lines: [], openLine: lineNo });
    } else if (['tip', 'info', 'note', 'warning', 'danger'].includes(kind)) {
      const tone = kind === 'note' ? 'INFO' : kind.toUpperCase();
      const title = stripOuterQuotes(argsRaw) || null;
      const node = { kind: 'callout', tone, title, children: [], line: lineNo };
      parentFrame.node.children.push(node);
      stack.push({ node, lines: [], openLine: lineNo });
    } else if (kind === 'diagram') {
      const attrs = argsRaw ? parseDirectiveAttrs(argsRaw, label, lineNo) : {};
      if (!attrs.src) fail(`${label} 第 ${lineNo} 行 ::: diagram 必须提供 src="assets/..." 属性`);
      const node = {
        kind: 'diagram',
        src: attrs.src,
        title: attrs.title || attrs.alt || '',
        alt: attrs.alt || attrs.title || '架构示意图',
        height: attrs.height || null,
        children: [],
        line: lineNo,
      };
      parentFrame.node.children.push(node);
      if (!selfClosing) stack.push({ node, lines: [], openLine: lineNo });
    } else {
      fail(`${label} 第 ${lineNo} 行使用了不支持的容器指令: ::: ${kind}`);
    }
  }

  if (stack.length > 1) {
    const unclosed = stack.at(-1);
    fail(`${label} 第 ${unclosed.openLine} 行的 ::: ${unclosed.node.kind} 容器未闭合`);
  }
  flushLines(stack[0]);
  return root;
}

function collectExplicitHeadingIds(node, explicitIds, label) {
  if (node.kind === 'markdown') {
    let lexed;
    try {
      lexed = Lexer.lex(node.text, { gfm: true, breaks: false, pedantic: false });
    } catch (cause) {
      throw new MarkdownCompileError(`${label} cannot be tokenized: ${cause.message}（Markdown 词法切分失败）`);
    }
    for (const token of lexed) {
      if (token.type !== 'heading') continue;
      if (token.depth === 1) {
        fail(`${label} must not contain an H1（正文不可包含 # 一级标题；主标题由 pages.json 的 title 唯一生成）`);
      }
      if (token.depth < 2 || token.depth > 5) {
        fail(`${label} heading levels must be H2-H5（正文章节标题支持 ## 至 #####）`);
      }
      const explicit = explicitHeading(token);
      if (!explicit) continue;
      if (explicit.id.startsWith('editorial-') || explicit.id.startsWith('doc-')) {
        fail(`${label} uses a reserved heading ID: ${explicit.id}（不可使用 editorial-* 或 doc-* 保留前缀作为标题锚点）`);
      }
      if (explicitIds.has(explicit.id)) {
        fail(`${label} contains duplicate heading ID: ${explicit.id}（同页章节锚点 ID 重复）`);
      }
      explicitIds.add(explicit.id);
    }
    return;
  }
  for (const child of node.children || []) collectExplicitHeadingIds(child, explicitIds, label);
}

function registerAsset(src, assets, label) {
  const normalized = String(src || '').trim();
  if (
    !normalized.startsWith('assets/')
    || normalized.includes('..')
    || normalized.includes('%2e')
    || normalized.includes('%2E')
    || !SAFE_ASSET_EXT.test(normalized)
    || normalized.startsWith('assets/editorial/')
    || ['assets/theme.css', 'assets/site.js', 'assets/mark.svg', 'assets/search-index.json'].includes(normalized)
  ) {
    fail(`${label} asset src must reference a contained file inside assets/ (${normalized})`);
  }
  assets.add(normalized);
  return normalized;
}

/**
 * @param {string} source
 * @param {{pageId:string,tokens?:Record<string,string|number|boolean>}} options
 * @returns {{blocks:object[],images:string[],assets:string[]}}
 */
export function compileMarkdown(source, { pageId, tokens = {} }) {
  if (typeof source !== 'string' || source.includes('\u0000')) {
    fail(`${pageId}.md must be UTF-8 text without NUL（须为不含空字符的 UTF-8 文本）`);
  }
  if (!SAFE_ID.test(pageId)) fail(`invalid page ID: ${pageId}（页面 ID 格式非法）`);

  const label = `${pageId}.md`;
  const tree = parseContainerTree(source, label);

  const explicitIds = new Set([pageId]);
  collectExplicitHeadingIds(tree, explicitIds, label);
  const usedIds = new Set(explicitIds);

  const assets = new Set();

  function inline(inlineTokens) {
    const list = inlineTokens || [];
    const result = [];
    for (let i = 0; i < list.length; i += 1) {
      const token = list[i];
      if (
        token.type === 'html'
        && /^<kbd>$/i.test(String(token.text || '').trim())
        && list[i + 1]?.type === 'text'
        && list[i + 2]?.type === 'html'
        && /^<\/kbd>$/i.test(String(list[i + 2].text || '').trim())
      ) {
        result.push({ type: 'kbd', text: replaceMarkdownTokens(list[i + 1].text, tokens, label) });
        i += 2;
        continue;
      }
      switch (token.type) {
        case 'text':
          if (token.tokens?.length) result.push(...inline(token.tokens));
          else result.push(replaceMarkdownTokens(token.text, tokens, label));
          break;
        case 'escape':
          result.push(replaceMarkdownTokens(token.text, tokens, label));
          break;
        case 'strong':
        case 'em':
        case 'del':
          result.push({ type: token.type, content: inline(token.tokens) });
          break;
        case 'codespan':
          result.push({ type: 'code', text: replaceMarkdownTokens(token.text, tokens, label) });
          break;
        case 'br':
          result.push({ type: 'br' });
          break;
        case 'link':
          result.push({
            type: 'link',
            href: replaceMarkdownTokens(token.href, tokens, `${label} link`),
            ...(token.title ? { title: replaceMarkdownTokens(token.title, tokens, `${label} link title`) } : {}),
            content: inline(token.tokens),
          });
          break;
        case 'image': {
          const src = registerAsset(
            replaceMarkdownTokens(token.href, tokens, `${label} image`),
            assets,
            label,
          );
          const alt = replaceMarkdownTokens(token.text || '', tokens, `${label} image alt`);
          result.push({ type: 'image', src, alt });
          break;
        }
        case 'html':
          result.push(...parseInlineSafeHtml(token.text, label));
          break;
        default:
          fail(`${label} uses unsupported inline syntax: ${token.type}（不支持的行内语法）`);
      }
    }
    return result;
  }

  function compileTokens(lexed) {
    const blocks = [];
    for (const token of lexed) {
      switch (token.type) {
        case 'space':
        case 'def':
          break;
        case 'hr':
          blocks.push({ type: 'hr' });
          break;
        case 'paragraph': {
          if (token.tokens.length === 1 && token.tokens[0].type === 'image') {
            const image = token.tokens[0];
            const src = registerAsset(
              replaceMarkdownTokens(image.href, tokens, `${label} image`),
              assets,
              label,
            );
            const alt = replaceMarkdownTokens(image.text || '', tokens, `${label} image alt`);
            blocks.push({ type: 'image', src, alt });
          } else {
            blocks.push({ type: 'paragraph', content: inline(token.tokens) });
          }
          break;
        }
        case 'heading': {
          const explicit = explicitHeading(token);
          const title = explicit?.title ?? token.text;
          let headingId = explicit?.id;
          if (!headingId) {
            const candidate = slug(title);
            const base = candidate.startsWith('editorial-') || candidate.startsWith('doc-')
              ? `section-${candidate}`
              : candidate;
            headingId = base;
            let suffix = 2;
            while (usedIds.has(headingId)) {
              headingId = `${base}-${suffix}`;
              suffix += 1;
            }
            usedIds.add(headingId);
          }
          const headingTokens = Lexer.lexInline(title, { gfm: true });
          blocks.push({ type: 'heading', level: token.depth, id: headingId, content: inline(headingTokens) });
          break;
        }
        case 'list': {
          const items = token.items.map((item) => compileListItem(item));
          blocks.push({
            type: 'list',
            ordered: token.ordered,
            start: token.ordered ? Number(token.start || 1) : 1,
            items,
          });
          break;
        }
        case 'table':
          blocks.push({
            type: 'table',
            align: token.align || [],
            headers: token.header.map((cell) => inline(cell.tokens)),
            rows: token.rows.map((row) => row.map((cell) => inline(cell.tokens))),
          });
          break;
        case 'code':
          blocks.push({
            type: 'code',
            language: (token.lang || 'text').trim().split(/\s+/)[0].toLowerCase(),
            text: replaceMarkdownTokens(token.text, tokens, `${label} code`),
          });
          break;
        case 'blockquote':
          blocks.push(compileBlockquote(token));
          break;
        case 'html':
          if (!isCommentOnlyHtml(token.text)) {
            fail(`${label} raw HTML is not supported（不支持内嵌原始 HTML，请改用 Markdown 或 ::: 容器语法）`);
          }
          break;
        default:
          fail(`${label} uses unsupported block syntax: ${token.type}（不支持的块级语法）`);
      }
    }
    return blocks;
  }

  function compileListItem(item) {
    const contentTokens = item.tokens.filter((t) => t.type !== 'space' && t.type !== 'checkbox');
    const blocks = [];
    for (const sub of contentTokens) {
      if (sub.type === 'text') {
        const subInline = sub.tokens || Lexer.lexInline(sub.text, { gfm: true });
        blocks.push({ type: 'paragraph', content: inline(subInline) });
      } else {
        blocks.push(...compileTokens([sub]));
      }
    }
    return {
      ...(item.task ? { checked: Boolean(item.checked) } : {}),
      blocks,
    };
  }

  function compileBlockquote(token) {
    const meaningful = token.tokens.filter((item) => item.type !== 'space');
    if (meaningful.length > 0 && meaningful[0].type === 'paragraph') {
      const firstPara = meaningful[0];
      const match = /^\[!(NOTE|TIP|INFO|WARNING|DANGER)\](?:[ \t]+([^\n]+))?(?:\n([\s\S]*))?$/i.exec(firstPara.text);
      if (match) {
        const rawTone = match[1].toUpperCase();
        const tone = rawTone === 'NOTE' ? 'INFO' : rawTone;
        const customTitle = match[2] ? inline(Lexer.lexInline(match[2].trim(), { gfm: true })) : null;
        const bodyText = (match[3] || '').trim();
        const calloutBlocks = [];
        if (bodyText) {
          calloutBlocks.push({ type: 'paragraph', content: inline(Lexer.lexInline(bodyText, { gfm: true })) });
        }
        if (meaningful.length > 1) {
          calloutBlocks.push(...compileTokens(meaningful.slice(1)));
        }
        if (!calloutBlocks.length) {
          fail(`${label} callout cannot be empty（提示框内容不能为空）`);
        }
        return {
          type: 'callout',
          tone,
          ...(customTitle?.length ? { title: customTitle } : {}),
          blocks: calloutBlocks,
        };
      }
    }
    return {
      type: 'blockquote',
      blocks: compileTokens(meaningful),
    };
  }

  function compileContainerChildren(children) {
    const out = [];
    for (const child of children) {
      if (child.kind === 'markdown') {
        const lexed = Lexer.lex(child.text, { gfm: true, breaks: false, pedantic: false });
        out.push(...compileTokens(lexed));
      } else if (child.kind === 'prompt') {
        const text = replaceMarkdownTokens(child.rawLines.join('\n'), tokens, `${label} prompt`);
        out.push({
          type: 'code',
          language: 'prompt',
          ...(child.title ? { title: replaceMarkdownTokens(child.title, tokens, `${label} prompt title`) } : {}),
          text,
        });
      } else if (child.kind === 'file-tree') {
        const nodes = parseFileTree(child.rawLines, tokens, label, child.line + 1);
        if (!nodes.length) fail(`${label} 第 ${child.line} 行 ::: file-tree 不能为空`);
        out.push({ type: 'file-tree', nodes });
      } else if (child.kind === 'callout') {
        const blocks = compileContainerChildren(child.children);
        if (!blocks.length) fail(`${label} 第 ${child.line} 行 ::: ${child.tone.toLowerCase()} 不能为空`);
        const titleTokens = child.title ? inline(Lexer.lexInline(child.title, { gfm: true })) : null;
        out.push({
          type: 'callout',
          tone: child.tone,
          ...(titleTokens?.length ? { title: titleTokens } : {}),
          blocks,
        });
      } else if (child.kind === 'tabs') {
        const tabs = child.children
          .filter((c) => c.kind === 'tab')
          .map((tab) => ({
            label: replaceMarkdownTokens(tab.label, tokens, `${label} tab label`),
            blocks: compileContainerChildren(tab.children),
          }));
        if (!tabs.length) fail(`${label} 第 ${child.line} 行 ::: tabs 至少需要一个 ::: tab`);
        if (child.children.some((c) => c.kind !== 'tab')) {
          fail(`${label} 第 ${child.line} 行 ::: tabs 内部只能包含 ::: tab 子块`);
        }
        out.push({
          type: 'tabs',
          ...(child.sync ? { sync: child.sync } : {}),
          tabs,
        });
      } else if (child.kind === 'cards') {
        const cards = child.children
          .filter((c) => c.kind === 'card')
          .map((card) => ({
            title: replaceMarkdownTokens(card.title, tokens, `${label} card title`),
            ...(card.href ? { href: replaceMarkdownTokens(card.href, tokens, `${label} card href`) } : {}),
            ...(card.icon ? { icon: card.icon } : {}),
            ...(card.badge ? { badge: replaceMarkdownTokens(card.badge, tokens, `${label} card badge`) } : {}),
            blocks: compileContainerChildren(card.children),
          }));
        if (!cards.length) fail(`${label} 第 ${child.line} 行 ::: cards 至少需要一个 ::: card`);
        if (child.children.some((c) => c.kind !== 'card')) {
          fail(`${label} 第 ${child.line} 行 ::: cards 内部只能包含 ::: card 子块`);
        }
        out.push({ type: 'cards', cards });
      } else if (child.kind === 'steps') {
        const innerBlocks = compileContainerChildren(child.children);
        const steps = buildSteps(innerBlocks, child.line);
        out.push({ type: 'steps', steps });
      } else if (child.kind === 'diagram') {
        const src = registerAsset(
          replaceMarkdownTokens(child.src, tokens, `${label} diagram src`),
          assets,
          label,
        );
        const title = child.title ? replaceMarkdownTokens(child.title, tokens, `${label} diagram title`) : '';
        const alt = replaceMarkdownTokens(child.alt, tokens, `${label} diagram alt`);
        const height = child.height ? Number.parseInt(child.height, 10) : null;
        if (height !== null && (!Number.isInteger(height) || height < 160 || height > 1600)) {
          fail(`${label} 第 ${child.line} 行 ::: diagram height 须为 160–1600 之间的整数像素`);
        }
        const captionBlocks = compileContainerChildren(child.children);
        out.push({
          type: 'diagram',
          src,
          title,
          alt,
          ...(height !== null ? { height } : {}),
          ...(captionBlocks.length ? { caption: captionBlocks } : {}),
        });
      }
    }
    return out;
  }

  function buildSteps(innerBlocks, openLine) {
    const hasHeading = innerBlocks.some((b) => b.type === 'heading');
    if (hasHeading) {
      const steps = [];
      let currentStep = null;
      for (const block of innerBlocks) {
        if (block.type === 'heading') {
          currentStep = {
            id: block.id,
            level: block.level,
            title: block.content,
            blocks: [],
          };
          steps.push(currentStep);
        } else if (currentStep) {
          currentStep.blocks.push(block);
        } else {
          currentStep = { title: null, blocks: [block] };
          steps.push(currentStep);
        }
      }
      return steps;
    }
    if (innerBlocks.length === 1 && innerBlocks[0].type === 'list') {
      return innerBlocks[0].items.map((item) => ({
        title: null,
        blocks: item.blocks,
      }));
    }
    fail(`${label} 第 ${openLine} 行 ::: steps 内部请使用 ### 步骤标题或列表组织步骤`);
  }

  const blocks = compileContainerChildren(tree.children);
  const assetList = [...assets].sort();
  return {
    blocks,
    images: assetList.filter((path) => path.endsWith('.svg')),
    assets: assetList,
  };
}
