// SPDX-License-Identifier: Apache-2.0
// 内容级泄漏扫描：解码后再匹配，防 HTML 实体 / JS 反转义 / URL 百分号编码绕过。
// 默认扫描绝对路径与私钥 / Token；项目特定的私有字面量通过调用方传入
// （来自 public-release.json 的 forbiddenPublicPaths / privateLiterals）。
// 字面量匹配大小写不敏感；实体解码跑两趟（防双重编码）。
// 命中抛 LeakScanError，由调用方归入各自的错误分类体系。
export const DEFAULT_LITERALS = [
  '/Users/',
  'C:\\Users\\',
  '/home/',
  '/private/',
];

export const DEFAULT_REGEXES = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{36}/,
  /gho_[A-Za-z0-9]{36}/,
  /ghu_[A-Za-z0-9]{36}/,
  /github_pat_[A-Za-z0-9_]{82}/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /AKIA[0-9A-Z]{16}/,
  /sk-[A-Za-z0-9]{32,}/,
];

// 泄漏命中专用错误类型：调用方可据 instanceof 归类退出码，不与配置错误混淆。
export class LeakScanError extends Error {}

// HTML 实体解码单趟。允许常见实体省略数字实体末尾分号（浏览器兼容形式）。
function entityDecode(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&sol;/gi, '/')
    .replace(/&#x([0-9a-fA-F]+);?/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (m, d) => String.fromCodePoint(parseInt(d, 10)));
}

// JS 转义序列反转义（\xNN / \uNNNN / \u{N} / 八进制 \NNN）。
function jsUnescape(s) {
  return s
    .replace(/\\x([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)));
}

// URL 百分号解码（逐字节 %XX → 字符；不调用 decodeURIComponent，畸形输入不抛）。
function pctDecode(s) {
  return s.replace(/%([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

// 对文本做多趟解码：HTML 实体两趟（防双重编码）→ JS 反转义 → URL 百分号解码，
// 各趟结果与原文拼接后统一扫描，使绕过者无法用各种编码把敏感字面量藏过匹配。
export function decodeText(s) {
  const entities = entityDecode(entityDecode(s));
  const unescaped = jsUnescape(entities);
  // 固定两趟百分号解码，覆盖双重编码但不允许输入驱动的无界循环。
  const percent = pctDecode(unescaped);
  const percentTwice = pctDecode(percent);
  return [s, entities, unescaped, percent, percentTwice].join('\n');
}

// relPath: 仅用于报错信息；text: 待扫描原文；opts.literals / opts.regexes 为追加项。
// 字面量匹配大小写不敏感（原文与小写化探针各匹配一趟，utf8 / utf16le 两编码）。
export function scanLeak(relPath, text, { literals = [], regexes = [] } = {}) {
  const probe = decodeText(text);
  const probeLower = probe.toLowerCase();
  const allLit = [...DEFAULT_LITERALS, ...literals];
  for (const lit of allLit) {
    const litLower = lit.toLowerCase();
    for (const enc of ['utf8', 'utf16le']) {
      if (
        Buffer.from(probe, enc).includes(Buffer.from(lit, enc)) ||
        Buffer.from(probeLower, enc).includes(Buffer.from(litLower, enc))
      ) {
        throw new LeakScanError(`[泄漏扫描] ${relPath} 命中私有字面量: ${lit}`);
      }
    }
  }
  const allRe = [...DEFAULT_REGEXES, ...regexes];
  for (const re of allRe) {
    if (re.test(probe)) throw new LeakScanError(`[泄漏扫描] ${relPath} 命中私有正则: ${re}`);
  }
}
