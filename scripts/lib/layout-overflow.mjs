// SPDX-License-Identifier: Apache-2.0
// @feature DOC2 @scenario S-04
// 多视口/宽元素版面溢出静态抽检（US-025）：检查已渲染 HTML 页面中无滚动容器的宽表格、
// 无边界代码块、未缩放 SVG/图片及固定像素宽度在多视口阈值下的横向溢出风险。
import { realpath } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { readFileContained, resolveContained } from 'skill-family-harness-node';

export const DEFAULT_VIEWPORTS = Object.freeze([320, 390, 768, 1280]);

export class LayoutOverflowError extends Error {
  constructor(findings, report) {
    super(report);
    this.findings = findings;
  }
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

export function parseViewportList(raw) {
  if (raw === undefined || raw === null) return [...DEFAULT_VIEWPORTS];
  if (Array.isArray(raw)) {
    if (!raw.length) throw new TypeError('视口列表不能为空');
    const nums = raw.map((v) => Number(v));
    if (nums.some((n) => !Number.isInteger(n) || n < 240 || n > 7680)) {
      throw new TypeError(`视口宽度必须是 240–7680 之间的整数像素值: ${raw.join(', ')}`);
    }
    return [...new Set(nums)].sort((a, b) => a - b);
  }
  const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new TypeError('--viewports 至少需要一个有效的像素宽度（如 320,390,768,1280）');
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number.parseInt(p, 10) : NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 240 || n > 7680)) {
    throw new TypeError(`--viewports 包含无效视口宽度（须为 240–7680 整数）: ${raw}`);
  }
  return [...new Set(nums)].sort((a, b) => a - b);
}

function stripPrintMediaAndComments(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '';
  let i = 0;
  const printMediaRe = /@media\s+print\b/gi;
  while (i < withoutComments.length) {
    printMediaRe.lastIndex = i;
    const match = printMediaRe.exec(withoutComments);
    if (!match) {
      out += withoutComments.slice(i);
      break;
    }
    const printIdx = match.index;
    out += withoutComments.slice(i, printIdx);
    const openBrace = withoutComments.indexOf('{', printIdx);
    if (openBrace === -1) break;
    let depth = 1;
    let cursor = openBrace + 1;
    while (cursor < withoutComments.length && depth > 0) {
      if (withoutComments[cursor] === '{') depth += 1;
      else if (withoutComments[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    i = cursor;
  }
  return out;
}

function recordRuleTokens(selectorsText, bodyText, bucket) {
  const hasScroll = /\boverflow(?:-x)?\s*:\s*(?:auto|scroll)\b/i.test(bodyText);
  const hasFluid = /\bmax-width\s*:\s*100%/i.test(bodyText);
  const hasWrap = /\bwhite-space\s*:\s*(?:pre-wrap|break-spaces|normal)\b/i.test(bodyText);
  if (!hasScroll && !hasFluid && !hasWrap) return;
  for (const rawSel of selectorsText.split(',')) {
    const sel = rawSel.trim();
    if (!sel) continue;
    const subject = sel.split(/\s*[>+~]\s*|\s+/).at(-1)?.trim();
    if (!subject || subject.includes(':') || subject.includes('[') || subject.includes('*')) continue;
    if (!/^(?:[a-z][a-z0-9]*)?(?:\.[A-Za-z0-9_-]+)+$/i.test(subject) && !/^[a-z][a-z0-9]*$/i.test(subject)) {
      continue;
    }
    const classes = [...subject.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    if (classes.length > 0) {
      for (const cls of classes) {
        if (hasScroll) bucket.scrollClasses.add(cls);
        if (hasFluid) bucket.fluidClasses.add(cls);
        if (hasWrap) bucket.wrapClasses.add(cls);
      }
    } else {
      const tag = subject.toLowerCase();
      if (hasScroll) bucket.scrollTags.add(tag);
      if (hasFluid) bucket.fluidTags.add(tag);
      if (hasWrap) bucket.wrapTags.add(tag);
    }
  }
}

export function analyzeStylesheet(cssText) {
  const bucket = {
    scrollClasses: new Set(),
    scrollTags: new Set(),
    fluidClasses: new Set(),
    fluidTags: new Set(),
    wrapClasses: new Set(),
    wrapTags: new Set(),
  };
  const screenCss = stripPrintMediaAndComments(cssText);
  // 提取顶层及非 print 块内的单选择器保护规则
  const flattened = screenCss.replace(/@media[^{]+\{/gi, '').replace(/\}/g, '}\n');
  for (const match of flattened.matchAll(/([^{}\n][^{}]*?)\{([^{}]*)\}/g)) {
    recordRuleTokens(match[1], match[2], bucket);
  }
  return bucket;
}

function mergeCssBuckets(buckets) {
  const merged = analyzeStylesheet('');
  for (const b of buckets) {
    for (const key of Object.keys(merged)) {
      b[key].forEach((item) => merged[key].add(item));
    }
  }
  return merged;
}

function parseAttributes(tagToken) {
  const attrs = new Map();
  const body = tagToken.replace(/^<\s*\/?\s*[a-z0-9:-]+/i, '').replace(/\/?\s*>$/, '');
  for (const m of body.matchAll(/([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs.set(m[1].toLowerCase(), val);
  }
  return attrs;
}

function parsePxStyle(styleText, prop) {
  if (!styleText) return null;
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)px\\b`, 'i');
  const m = re.exec(styleText);
  return m ? Number(m[1]) : null;
}

function parsePxAttr(value) {
  if (!value) return null;
  const m = /^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/i.exec(value);
  return m ? Number(m[1]) : null;
}

function stripTagsToText(htmlFragment) {
  return htmlFragment
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, 'x');
}

function estimateLinePx(text, cjkPx = 14, asciiPx = 8) {
  let width = 0;
  for (const ch of text) {
    width += ch.codePointAt(0) > 0x7f ? cjkPx : asciiPx;
  }
  return Math.ceil(width);
}

function nodeHasScroll(node, css) {
  const st = node.style;
  if (/\boverflow(?:-x)?\s*:\s*visible\b/i.test(st)) return false;
  if (/\boverflow(?:-x)?\s*:\s*(?:auto|scroll)\b/i.test(st)) return true;
  if (css.scrollTags.has(node.tag)) return true;
  return node.classes.some((c) => css.scrollClasses.has(c));
}

function nodeHasFluidWidth(node, css) {
  const st = node.style;
  if (/\bmax-width\s*:\s*none\b/i.test(st)) return false;
  if (/\bmax-width\s*:\s*(?:100%|min\()/i.test(st) || /\bwidth\s*:\s*min\([^)]*100/i.test(st)) return true;
  if (css.fluidTags.has(node.tag)) return true;
  return node.classes.some((c) => css.fluidClasses.has(c));
}

function nodeHasPreWrap(node, css) {
  const st = node.style;
  if (/\bwhite-space\s*:\s*(?:pre|nowrap)\b/i.test(st)) return false;
  if (/\bwhite-space\s*:\s*(?:pre-wrap|break-spaces|normal)\b/i.test(st)) return true;
  if (css.wrapTags.has(node.tag)) return true;
  return node.classes.some((c) => css.wrapClasses.has(c));
}

function matchingCloseIndex(html, startAfterOpen, tagName) {
  const re = new RegExp(`<\\s*(\\/?)\\s*${tagName}\\b[^>]*>`, 'gi');
  re.lastIndex = startAfterOpen;
  let depth = 1;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1] === '/') depth -= 1;
    else if (!/\/\s*>$/.test(m[0])) depth += 1;
    if (depth === 0) return m.index;
  }
  return html.length;
}

function estimateTableWidth(innerHtml) {
  let maxCols = 0;
  let maxRowPx = 0;
  for (const rowMatch of innerHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)];
    maxCols = Math.max(maxCols, cells.length);
    const rowPx = cells.reduce((sum, cell) => sum + Math.max(88, estimateLinePx(stripTagsToText(cell[1]).trim()) + 28), 0);
    maxRowPx = Math.max(maxRowPx, rowPx);
  }
  return { colCount: maxCols, estimatedPx: Math.max(maxCols * 110, maxRowPx) };
}

function estimatePreWidth(innerHtml) {
  const lines = stripTagsToText(innerHtml).split(/\r?\n/);
  const maxPx = lines.reduce((acc, line) => Math.max(acc, estimateLinePx(line, 13, 7.8)), 0);
  return maxPx + 32;
}

function maskScriptsAndComments(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => m.replace(/[^\n]/g, ' '));
}

async function loadPageCss(targetDir, pagePath, rawHtml, cache) {
  const buckets = [];
  for (const styleMatch of rawHtml.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    buckets.push(analyzeStylesheet(styleMatch[1]));
  }
  for (const linkMatch of rawHtml.matchAll(/<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi)) {
    const attrs = parseAttributes(linkMatch[0]);
    const href = attrs.get('href');
    if (!href || /^(?:[a-z]+:|\/\/|\/)/i.test(href)) continue;
    const cleanHref = href.split('#', 1)[0].split('?', 1)[0];
    try {
      const cssAbs = await resolveContained(targetDir, relative(targetDir, resolve(dirname(pagePath), cleanHref)));
      const cssRel = relative(targetDir, cssAbs);
      if (!cache.has(cssRel)) {
        const text = await readFileContained(targetDir, cssRel, { encoding: 'utf8' });
        cache.set(cssRel, analyzeStylesheet(text));
      }
      buckets.push(cache.get(cssRel));
    } catch {
      // 缺失或越界 CSS 由链接检查器负责报告，此处保持保守无保护假设
    }
  }
  return mergeCssBuckets(buckets);
}

async function readLocalSvgMeta(targetDir, pagePath, srcAttr, svgMetaCache) {
  if (!srcAttr || /^(?:[a-z]+:|\/\/|\/)/i.test(srcAttr)) return { width: null, lightBgPaint: null, rel: null };
  const cleanSrc = srcAttr.split('#', 1)[0].split('?', 1)[0];
  if (extname(cleanSrc).toLowerCase() !== '.svg') return { width: null, lightBgPaint: null, rel: null };
  try {
    const svgAbs = await resolveContained(targetDir, relative(targetDir, resolve(dirname(pagePath), cleanSrc)));
    const svgRel = relative(targetDir, svgAbs).replaceAll('\\', '/');
    if (!svgMetaCache.has(svgRel)) {
      const svgText = await readFileContained(targetDir, svgRel, { encoding: 'utf8' });
      const rootTag = /<svg\b[^>]*>/i.exec(svgText)?.[0];
      const attrs = rootTag ? parseAttributes(rootTag) : new Map();
      const vbParts = (attrs.get('viewbox') || '').trim().split(/[\s,]+/).map(Number);
      const vbWidth = vbParts.length === 4 && Number.isFinite(vbParts[2]) ? vbParts[2] : null;
      const w = parsePxAttr(attrs.get('width')) ?? parsePxStyle(attrs.get('style') || '', 'width');
      const effectiveW = w ?? vbWidth;
      const lightBgPaint = (svgRel === 'assets/mark.svg' || (effectiveW !== null && effectiveW <= 64))
        ? null
        : inspectSvgDarkModeIssue(svgText);
      svgMetaCache.set(svgRel, { width: w, lightBgPaint, rel: svgRel });
    }
    return svgMetaCache.get(svgRel);
  } catch {
    return { width: null, lightBgPaint: null, rel: null };
  }
}

function parseHexBright(hex) {
  const raw = hex.replace(/^#/, '');
  let r;
  let g;
  let b;
  if (raw.length === 3) {
    r = Number.parseInt(raw[0] + raw[0], 16);
    g = Number.parseInt(raw[1] + raw[1], 16);
    b = Number.parseInt(raw[2] + raw[2], 16);
  } else if (raw.length === 6) {
    r = Number.parseInt(raw.slice(0, 2), 16);
    g = Number.parseInt(raw.slice(2, 4), 16);
    b = Number.parseInt(raw.slice(4, 6), 16);
  } else {
    return false;
  }
  return r >= 232 && g >= 236 && b >= 236;
}

function isBrightLightPaint(rawPaint, defsText = '') {
  const paint = String(rawPaint || '').trim();
  if (!paint) return false;
  const lower = paint.toLowerCase();
  if (lower === 'none' || lower === 'transparent' || lower === 'currentcolor' || lower.includes('var(')) {
    return false;
  }
  if (lower === 'white') return true;
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(lower)) return parseHexBright(lower);
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/i.exec(lower);
  if (rgb) {
    const alpha = rgb[4] !== undefined ? Number(rgb[4]) : 1;
    return alpha >= 0.5 && Number(rgb[1]) >= 232 && Number(rgb[2]) >= 236 && Number(rgb[3]) >= 236;
  }
  const urlMatch = /^url\(\s*['"]?#([A-Za-z0-9_-]+)['"]?\s*\)$/i.exec(paint);
  if (urlMatch && defsText) {
    const gradRe = new RegExp(`<(?:linearGradient|radialGradient)\\b[^>]*\\bid\\s*=\\s*["']${urlMatch[1]}["'][^>]*>([\\s\\S]*?)<\\/(?:linearGradient|radialGradient)>`, 'i');
    const gradMatch = gradRe.exec(defsText);
    if (gradMatch) {
      const stops = [...gradMatch[1].matchAll(/stop-color\s*(?:=\s*["']([^"']+)["']|:\s*([^;"'\s]+))/gi)]
        .map((m) => m[1] || m[2])
        .filter(Boolean);
      return stops.length > 0 && stops.every((c) => isBrightLightPaint(c, ''));
    }
  }
  return false;
}

export function inspectSvgDarkModeIssue(svgText) {
  const clean = String(svgText || '').replace(/<!--[\s\S]*?-->/g, '');
  if (/prefers-color-scheme\s*:\s*dark|data-theme\s*=\s*["']dark["']|\.dark\b|light-dark\(/i.test(clean)) {
    return null;
  }
  const defsText = [...clean.matchAll(/<defs\b[^>]*>([\s\S]*?)<\/defs>/gi)].map((m) => m[1]).join('\n');
  const body = clean
    .replace(/<defs\b[^>]*>[\s\S]*?<\/defs>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  const firstRect = /<rect\b[^>]*>/i.exec(body)?.[0];
  if (!firstRect) return null;
  const attrs = parseAttributes(firstRect);
  const styleText = attrs.get('style') || '';
  const wAttr = attrs.get('width') || '';
  const hAttr = attrs.get('height') || '';
  const numW = parsePxAttr(wAttr);
  const numH = parsePxAttr(hAttr);
  if ((numW !== null && numW < 120 && !wAttr.endsWith('%')) || (numH !== null && numH < 64 && !hAttr.endsWith('%'))) {
    return null;
  }
  const fillOpacity = Number(attrs.get('fill-opacity') ?? (/fill-opacity\s*:\s*([0-9.]+)/i.exec(styleText)?.[1] ?? '1'));
  if (Number.isFinite(fillOpacity) && fillOpacity < 0.35) return null;
  const fillVal = attrs.get('fill') || (/fill\s*:\s*([^;]+)/i.exec(styleText)?.[1]?.trim() ?? '');
  return isBrightLightPaint(fillVal, defsText) ? fillVal : null;
}

export async function checkLayoutOverflow({
  targetRoot,
  pageIds,
  viewports = DEFAULT_VIEWPORTS,
} = {}) {
  const targetDir = await realpath(resolve(targetRoot));
  const vpList = parseViewportList(viewports);
  const cssCache = new Map();
  const svgMetaCache = new Map();
  const findings = [];
  const htmlFiles = pageIds.map((id) => (id.endsWith('.html') ? id : `${id}.html`));

  for (const htmlFile of htmlFiles) {
    await resolveContained(targetDir, htmlFile);
    const rawHtml = await readFileContained(targetDir, htmlFile, { encoding: 'utf8' });
    const pagePath = resolve(targetDir, htmlFile);
    const css = await loadPageCss(targetDir, pagePath, rawHtml, cssCache);
    const masked = maskScriptsAndComments(rawHtml);

    const lineStarts = [0];
    for (let idx = 0; idx < masked.length; idx += 1) {
      if (masked[idx] === '\n') lineStarts.push(idx + 1);
    }
    const lineOfOffset = (offset) => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lineStarts[mid] <= offset) lo = mid + 1;
        else hi = mid - 1;
      }
      return Math.max(1, hi + 1);
    };

    const stack = [];
    const tagRe = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)\b[^>]*>/g;
    let m;
    while ((m = tagRe.exec(masked)) !== null) {
      const token = m[0];
      const closing = m[1] === '/';
      const tag = m[2].toLowerCase();
      if (closing) {
        for (let k = stack.length - 1; k >= 0; k -= 1) {
          if (stack[k].tag === tag) {
            stack.length = k;
            break;
          }
        }
        continue;
      }

      const attrs = parseAttributes(token);
      const classes = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
      const style = attrs.get('style') || '';
      const line = lineOfOffset(m.index);
      const selfClosing = /\/\s*>$/.test(token) || VOID_TAGS.has(tag);
      const node = { tag, line, classes, style, attrs };
      const ancestorScrolled = stack.some((anc) => nodeHasScroll(anc, css));
      const selfScrolled = nodeHasScroll(node, css);

      if (tag === 'table') {
        const closeIdx = matchingCloseIndex(masked, m.index + token.length, 'table');
        const { colCount, estimatedPx } = estimateTableWidth(masked.slice(m.index + token.length, closeIdx));
        const inlineFixed = parsePxStyle(style, 'width') ?? parsePxStyle(style, 'min-width') ?? parsePxAttr(attrs.get('width'));
        const requiredPx = Math.max(estimatedPx, inlineFixed || 0);
        if (!ancestorScrolled && !selfScrolled) {
          const hitVps = vpList.filter((vp) => requiredPx > vp - 24);
          if (hitVps.length) {
            findings.push({
              file: htmlFile,
              line,
              kind: 'unwrapped-wide-table',
              element: `<table>（${colCount} 列，估算宽 ${requiredPx}px）`,
              viewports: hitVps,
              suggestion: '请在外层包裹横向滚动容器（如 <div class="table-scroll"> 并设置 max-width: 100%; overflow-x: auto），避免窄屏撑破正文。',
            });
          }
        }
      } else if (tag === 'pre') {
        const closeIdx = matchingCloseIndex(masked, m.index + token.length, 'pre');
        const estimatedPx = estimatePreWidth(masked.slice(m.index + token.length, closeIdx));
        const inlineFixed = parsePxStyle(style, 'width') ?? parsePxStyle(style, 'min-width');
        const hasWrap = nodeHasPreWrap(node, css);
        const fluidOk = inlineFixed === null || nodeHasFluidWidth(node, css);
        if ((!ancestorScrolled && !selfScrolled && !hasWrap) || !fluidOk) {
          const requiredPx = Math.max(estimatedPx, inlineFixed || 0);
          const hitVps = vpList.filter((vp) => requiredPx > vp - 24);
          if (hitVps.length) {
            findings.push({
              file: htmlFile,
              line,
              kind: 'unbounded-code-block',
              element: `<pre>（估算宽 ${requiredPx}px）`,
              viewports: hitVps,
              suggestion: '请为 <pre> 保留 max-width: 100%; overflow-x: auto，或对提示词文本启用 white-space: pre-wrap; overflow-wrap: anywhere。',
            });
          }
        }
      } else if (tag === 'img' || tag === 'svg') {
        const attrW = parsePxAttr(attrs.get('width'));
        const styleW = parsePxStyle(style, 'width') ?? parsePxStyle(style, 'min-width');
        const svgMeta = tag === 'img'
          ? await readLocalSvgMeta(targetDir, pagePath, attrs.get('src'), svgMetaCache)
          : { width: null, lightBgPaint: null, rel: null };
        const pxWidth = styleW ?? attrW ?? svgMeta.width;
        const decorativeSmall = (attrs.get('aria-hidden') === 'true' && (pxWidth === null || pxWidth <= 64))
          || (pxWidth !== null && pxWidth <= 64);
        if (!decorativeSmall) {
          let lightBgPaint = svgMeta.lightBgPaint;
          if (tag === 'svg') {
            const closeSvgIdx = matchingCloseIndex(rawHtml, m.index + token.length, 'svg');
            lightBgPaint = inspectSvgDarkModeIssue(rawHtml.slice(m.index, closeSvgIdx));
          }
          if (lightBgPaint) {
            findings.push({
              file: htmlFile,
              line,
              kind: 'svg-hardcoded-light-bg',
              element: tag === 'img'
                ? `<img src="${svgMeta.rel || attrs.get('src')}">（SVG 根背景硬编码浅亮底色 ${lightBgPaint}，缺少深色模式适配）`
                : `<svg>（根背景硬编码浅亮底色 ${lightBgPaint}，缺少深色模式适配）`,
              viewports: vpList,
              suggestion: '请将 SVG 根背景改为透明/半透明，或在 SVG <style> 中补充 @media (prefers-color-scheme: dark) 与 CSS 变量深色配色，杜绝深色模式下出现刺眼纯白方块。',
            });
          }
        }
        if (!decorativeSmall && pxWidth !== null && pxWidth > 64 && !ancestorScrolled) {
          const fluid = nodeHasFluidWidth(node, css) && parsePxStyle(style, 'min-width') === null && !(styleW !== null && !/\bmax-width\s*:\s*100%/i.test(style));
          const missingViewBox = tag === 'svg' && !attrs.has('viewbox');
          if (!fluid || missingViewBox) {
            const hitVps = vpList.filter((vp) => pxWidth > vp - 24);
            if (hitVps.length) {
              findings.push({
                file: htmlFile,
                line,
                kind: 'unscaled-media',
                element: `<${tag}>（声明宽 ${pxWidth}px${missingViewBox ? '，缺少 viewBox' : ''}）`,
                viewports: hitVps,
                suggestion: tag === 'svg'
                  ? '请为宽 <svg> 补充 viewBox 并设置 max-width: 100%; height: auto，或改为经受保护的 <img> 引用站内 SVG。'
                  : '请确保 <img> 应用 max-width: 100%; height: auto，避免使用未配自适应约束的固定像素宽度。',
              });
            }
          }
        }
      } else if (!ancestorScrolled && !selfScrolled) {
        const fixedW = parsePxStyle(style, 'width');
        const minW = parsePxStyle(style, 'min-width');
        const candidatePx = minW ?? (fixedW !== null && !nodeHasFluidWidth(node, css) ? fixedW : null);
        if (candidatePx !== null) {
          const hitVps = vpList.filter((vp) => candidatePx > vp);
          if (hitVps.length) {
            findings.push({
              file: htmlFile,
              line,
              kind: 'fixed-px-width',
              element: `<${tag}>（固定像素约束 ${candidatePx}px）`,
              viewports: hitVps,
              suggestion: `请将固定像素宽度（${candidatePx}px）改为自适应写法（如 width: min(${candidatePx}px, 100%) 或配合 max-width: 100%）。`,
            });
          }
        }
      }

      if (!selfClosing) stack.push(node);
    }
  }

  const viewportSummary = vpList.map((vp) => {
    const hits = findings.filter((f) => f.viewports.includes(vp));
    return { viewport: vp, ok: hits.length === 0, issueCount: hits.length };
  });

  return {
    ok: findings.length === 0,
    pagesChecked: htmlFiles.length,
    viewports: vpList,
    viewportSummary,
    findings,
  };
}

export function formatLayoutOverflowReport(result, repoName = '(site)') {
  const vpText = result.viewportSummary
    .map((item) => `${item.viewport}px:${item.ok ? '通过' : `${item.issueCount}项风险`}`)
    .join(', ');
  const lines = [
    `[render-public-site --check-layout] ${repoName}: 已抽检 ${result.pagesChecked} 个渲染页面（${vpText}）`,
  ];
  if (result.ok) {
    lines.push(`[render-public-site --check-layout] ${repoName}: 多视口版面溢出抽检通过`);
    return lines.join('\n');
  }
  lines.push(`[render-public-site --check-layout] ${repoName}: 检出 ${result.findings.length} 处宽元素横向溢出风险:`);
  for (const item of result.findings) {
    lines.push(`  - ${item.file}:L${item.line} [${item.kind}] ${item.element} | 受影响视口: ${item.viewports.map((v) => `${v}px`).join(', ')}`);
    lines.push(`    修复建议: ${item.suggestion}`);
  }
  return lines.join('\n');
}
