// SPDX-License-Identifier: Apache-2.0
// 将受限 markdown-v1 编译为 editorial 模板的语义内容块。
import { Lexer } from 'marked';

const TOKEN = /@[A-Z0-9_]+@/g;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export class MarkdownV1Error extends TypeError {
  constructor(message) {
    super(`markdown-v1: ${message}`);
  }
}

const fail = (message) => { throw new MarkdownV1Error(message); };

/** Replace configured facts as literal data, never as Markdown syntax. */
export function replaceMarkdownTokens(value, tokens, label = 'text') {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const replaced = value.replace(TOKEN, (match) => (
    Object.hasOwn(tokens, match) ? String(tokens[match]) : match
  ));
  const residual = replaced.match(TOKEN);
  if (residual) fail(`${label} contains unresolved token(s): ${[...new Set(residual)].join(', ')}`);
  return replaced;
}

function inline(tokens, facts, label) {
  const result = [];
  for (const token of tokens || []) {
    switch (token.type) {
      case 'text':
        if (token.tokens?.length) result.push(...inline(token.tokens, facts, label));
        else result.push(replaceMarkdownTokens(token.text, facts, label));
        break;
      case 'escape':
        result.push(replaceMarkdownTokens(token.text, facts, label));
        break;
      case 'strong':
      case 'em':
        result.push({ type: token.type, content: inline(token.tokens, facts, label) });
        break;
      case 'codespan':
        result.push({ type: 'code', text: replaceMarkdownTokens(token.text, facts, label) });
        break;
      case 'link':
        if (token.title) fail(`${label} link titles are not supported`);
        result.push({
          type: 'link',
          href: replaceMarkdownTokens(token.href, facts, `${label} link`),
          content: inline(token.tokens, facts, label),
        });
        break;
      case 'image':
        fail(`${label} images must be the only content in their paragraph`);
        break;
      case 'html':
        fail(`${label} raw HTML is not supported`);
        break;
      default:
        fail(`${label} uses unsupported inline syntax: ${token.type}`);
    }
  }
  return result;
}

function listItem(item, facts, label) {
  if (item.task || item.checked !== undefined) fail(`${label} task lists are not supported`);
  const content = item.tokens.filter((token) => token.type !== 'space');
  if (content.length !== 1 || !['text', 'paragraph'].includes(content[0].type)) {
    fail(`${label} nested or multi-paragraph list items are not supported`);
  }
  const token = content[0];
  return inline(token.tokens || Lexer.lexInline(token.text, { gfm: true }), facts, label);
}

function explicitHeading(token) {
  const match = /^(.*\S)\s+\{#([A-Za-z0-9][A-Za-z0-9_-]*)\}\s*$/.exec(token.text);
  if (!match) {
    if (/\s+\{[^}]*\}\s*$/.test(token.text)) fail('heading contains an unsupported or invalid attribute extension');
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

function callout(token, facts, label) {
  const meaningful = token.tokens.filter((item) => item.type !== 'space');
  if (meaningful.length !== 1 || meaningful[0].type !== 'paragraph') {
    fail(`${label} callout must contain one paragraph`);
  }
  const match = /^\[!(NOTE|TIP|WARNING)\]\s*\n([\s\S]*\S)\s*$/.exec(meaningful[0].text);
  if (!match) fail(`${label} blockquotes must use NOTE, TIP, or WARNING callout syntax`);
  return {
    type: 'callout',
    tone: match[1],
    content: inline(Lexer.lexInline(match[2], { gfm: true }), facts, label),
  };
}

/**
 * @param {string} source
 * @param {{pageId:string,tokens?:Record<string,string|number|boolean>}} options
 * @returns {{blocks:object[],images:string[]}}
 */
export function compileMarkdownV1(source, { pageId, tokens = {} }) {
  if (typeof source !== 'string' || source.includes('\u0000')) fail(`${pageId}.md must be UTF-8 text without NUL`);
  if (!SAFE_ID.test(pageId)) fail(`invalid page ID: ${pageId}`);

  let lexed;
  try {
    lexed = Lexer.lex(source, { gfm: true, breaks: false, pedantic: false });
  } catch (cause) {
    throw new MarkdownV1Error(`${pageId}.md cannot be tokenized: ${cause.message}`);
  }

  const explicitIds = new Set([pageId]);
  for (const token of lexed) {
    if (token.type !== 'heading') continue;
    if (token.depth === 1) fail(`${pageId}.md must not contain an H1`);
    if (![2, 3, 4].includes(token.depth)) fail(`${pageId}.md heading levels must be H2-H4`);
    const explicit = explicitHeading(token);
    if (!explicit) continue;
    if (explicit.id.startsWith('editorial-')) fail(`${pageId}.md uses a reserved heading ID: ${explicit.id}`);
    if (explicitIds.has(explicit.id)) fail(`${pageId}.md contains duplicate heading ID: ${explicit.id}`);
    explicitIds.add(explicit.id);
  }

  const usedIds = new Set(explicitIds);
  const blocks = [];
  const images = new Set();
  for (const token of lexed) {
    const label = `${pageId}.md`;
    switch (token.type) {
      case 'space':
        break;
      case 'paragraph': {
        if (token.tokens.length === 1 && token.tokens[0].type === 'image') {
          const image = token.tokens[0];
          if (image.title) fail(`${label} image titles are not supported`);
          const src = replaceMarkdownTokens(image.href, tokens, `${label} image`);
          const alt = replaceMarkdownTokens(image.text, tokens, `${label} image alt`);
          blocks.push({ type: 'image', src, alt });
          images.add(src);
        } else {
          blocks.push({ type: 'paragraph', content: inline(token.tokens, tokens, label) });
        }
        break;
      }
      case 'heading': {
        const explicit = explicitHeading(token);
        const title = explicit?.title ?? token.text;
        let headingId = explicit?.id;
        if (!headingId) {
          const candidate = slug(title);
          const base = candidate.startsWith('editorial-') ? `section-${candidate}` : candidate;
          headingId = base;
          let suffix = 2;
          while (usedIds.has(headingId)) {
            headingId = `${base}-${suffix}`;
            suffix += 1;
          }
          usedIds.add(headingId);
        }
        const headingTokens = Lexer.lexInline(title, { gfm: true });
        blocks.push({ type: 'heading', level: token.depth, id: headingId, content: inline(headingTokens, tokens, label) });
        break;
      }
      case 'list':
        if (token.ordered && token.start !== 1) fail(`${label} ordered lists must start at 1`);
        blocks.push({
          type: 'list',
          ordered: token.ordered,
          items: token.items.map((item, index) => listItem(item, tokens, `${label} list item ${index + 1}`)),
        });
        break;
      case 'table':
        blocks.push({
          type: 'table',
          headers: token.header.map((cell) => inline(cell.tokens, tokens, label)),
          rows: token.rows.map((row) => row.map((cell) => inline(cell.tokens, tokens, label))),
        });
        break;
      case 'code':
        if (!token.lang || token.codeBlockStyle === 'indented') fail(`${label} code fences require a language marker`);
        blocks.push({
          type: 'code',
          language: token.lang,
          text: replaceMarkdownTokens(token.text, tokens, `${label} code`),
        });
        break;
      case 'blockquote':
        blocks.push(callout(token, tokens, label));
        break;
      case 'html':
        fail(`${label} raw HTML is not supported`);
        break;
      case 'def':
        fail(`${label} reference definitions are not supported`);
        break;
      default:
        fail(`${label} uses unsupported block syntax: ${token.type}`);
    }
  }
  return { blocks, images: [...images].sort() };
}
