// SPDX-License-Identifier: Apache-2.0
// 对项目内容 SVG 做保守的主动内容检查；模板自带图标不走此入口。

export class SvgSafetyError extends TypeError {
  constructor(path, message) {
    super(`unsafe SVG ${path}: ${message}`);
  }
}

const reject = (path, message) => { throw new SvgSafetyError(path, message); };

function decodeCssEscapes(value) {
  return value
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_match, digits) => {
      const codePoint = Number.parseInt(digits, 16);
      return codePoint === 0 || codePoint > 0x10ffff ? '\uFFFD' : String.fromCodePoint(codePoint);
    })
    .replace(/\\([^\r\n\f])/g, '$1');
}

export function assertSafeSvg(text, path) {
  if (typeof text !== 'string' || !text.trim()) reject(path, 'file must be nonempty UTF-8 text');
  if (text.includes('\u0000')) reject(path, 'NUL is not allowed');
  if (!/^\s*(?:<\?xml\s[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(text)) {
    reject(path, 'root element must be svg');
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) reject(path, 'DTD and entity declarations are not allowed');
  if (/<\/?(?:[A-Za-z_][\w.-]*:)?(?:script|foreignObject)(?:\s|\/?>)/i.test(text)) {
    reject(path, 'script and foreignObject elements are not allowed');
  }
  if (/\s(?:[A-Za-z_][\w.-]*:)?on[a-z0-9_.:-]*\s*=/i.test(text)) reject(path, 'event attributes are not allowed');
  if (/<\?(?!xml\s)[\s\S]*?\?>/i.test(text)) reject(path, 'processing instructions are not allowed');
  if (/\b(?:href|xlink:href|src)\s*=\s*(["'])(?!#)[\s\S]*?\1/i.test(text)) {
    reject(path, 'external resource references are not allowed');
  }
  if (/\b(?:href|xlink:href|src)\s*=\s*[^\s"'=<>`]+/i.test(text)) {
    reject(path, 'resource references must be quoted local fragments');
  }
  const decodedCss = decodeCssEscapes(text);
  if (/@import\b/i.test(decodedCss)) reject(path, 'CSS imports are not allowed');
  for (const match of decodedCss.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    if (!/^#[A-Za-z0-9][A-Za-z0-9_-]*$/.test(match[2])) reject(path, 'CSS URLs must be local fragments');
  }
  return text;
}
