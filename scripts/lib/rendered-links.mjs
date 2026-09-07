// SPDX-License-Identifier: Apache-2.0
// 只读检查已渲染站点的相对页面、资源、CSS 依赖与页内锚点。
import { dirname, extname, relative, resolve } from 'node:path';
import { readFileContained, resolveContained } from 'skill-family-harness-node';

export class RenderedLinksError extends Error {
  constructor(failures) {
    super(`${failures.length} 个链接失败:\n  - ${failures.join('\n  - ')}`);
    this.failures = failures;
  }
}

function isExternal(value) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);
}

function anchorsOf(html) {
  const anchors = new Set();
  for (const match of html.matchAll(/\s(?:id|name)\s*=\s*["']([^"']+)["']/gi)) anchors.add(match[1]);
  return anchors;
}

function referencesOf(html) {
  const refs = [];
  for (const match of html.matchAll(/\s(?:href|src)\s*=\s*["']([^"']+)["']/gi)) refs.push(match[1].trim());
  return refs;
}

function cssReferencesOf(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const refs = [];
  for (const match of withoutComments.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) refs.push(match[2].trim());
  for (const match of withoutComments.matchAll(/@import\s+(?!url\()(["'])(.*?)\1/gi)) refs.push(match[2].trim());
  return refs;
}

/**
 * @param {{targetRoot:string,pageIds:string[]}} input
 * @returns {Promise<{pages:number}>}
 */
export async function checkRenderedLinks({ targetRoot, pageIds }) {
  const targetDir = resolve(targetRoot);
  const htmlFiles = pageIds.map((id) => `${id}.html`);
  const textCache = new Map();
  const loadText = async (path) => {
    if (!textCache.has(path)) {
      textCache.set(path, await readFileContained(targetDir, relative(targetDir, path), { encoding: 'utf8' }));
    }
    return textCache.get(path);
  };
  const failures = [];
  const visitedCss = new Set();
  const visitedHtml = new Set();

  async function inspectReference({ originPath, originLabel, raw }) {
    if (!raw || raw === '#' || isExternal(raw)) return;
    if (raw.startsWith('/')) {
      failures.push(`${originLabel}: ${raw} 使用站点根绝对路径，部署到仓库子路径后会失效`);
      return;
    }
    const [withoutFragment, fragment = ''] = raw.split('#', 2);
    const pathPart = withoutFragment.split('?', 1)[0];
    let decoded;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      failures.push(`${originLabel}: ${raw} 含无效 URL 编码`);
      return;
    }
    const candidate = decoded ? resolve(dirname(originPath), decoded) : originPath;
    let target;
    try {
      target = candidate === originPath
        ? originPath
        : await resolveContained(targetDir, relative(targetDir, candidate));
      await readFileContained(targetDir, relative(targetDir, target));
    } catch {
      failures.push(`${originLabel}: ${raw} 指向不存在、越界或经过不安全符号链接的页面或资源`);
      return;
    }
    const extension = extname(target).toLowerCase();
    if (fragment && extension === '.html') {
      const targetHtml = await loadText(target);
      let decodedFragment;
      try {
        decodedFragment = decodeURIComponent(fragment);
      } catch {
        failures.push(`${originLabel}: ${raw} 含无效锚点编码`);
        return;
      }
      if (!anchorsOf(targetHtml).has(decodedFragment)) failures.push(`${originLabel}: ${raw} 指向不存在的页内锚点`);
    }
    if (extension === '.html') await inspectHtml(target, relative(targetDir, target).replaceAll('\\', '/'));
    if (extension === '.css') {
      const cssRel = relative(targetDir, target).replaceAll('\\', '/');
      if (visitedCss.has(cssRel)) return;
      visitedCss.add(cssRel);
      const css = await loadText(target);
      for (const cssRef of cssReferencesOf(css)) {
        await inspectReference({ originPath: target, originLabel: cssRel, raw: cssRef });
      }
    }
  }

  async function inspectHtml(pagePath, htmlFile, required = false) {
    if (visitedHtml.has(htmlFile)) return;
    visitedHtml.add(htmlFile);
    let html;
    try {
      html = await loadText(pagePath);
    } catch {
      if (required) failures.push(`${htmlFile}: 生成页面不存在`);
      return;
    }
    for (const raw of referencesOf(html)) await inspectReference({ originPath: pagePath, originLabel: htmlFile, raw });
  }

  for (const htmlFile of htmlFiles) {
    await inspectHtml(resolve(targetDir, htmlFile), htmlFile, true);
  }

  if (failures.length) throw new RenderedLinksError(failures);
  return { pages: htmlFiles.length };
}
