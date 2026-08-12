// SPDX-License-Identifier: Apache-2.0
// 内容级泄漏扫描：解码后再匹配，防 HTML 实体 / JS 反转义绕过。
// 默认扫描绝对路径与私钥 / Token；项目特定的私有字面量通过调用方传入
// （来自 public-release.json 的 forbiddenPublicPaths / privateLiterals）。
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

// 对文本做 HTML 实体解码 + JS 反转义，得到规范化文本，与原文拼接后扫描，
// 使绕过者无法用实体 / 转义把敏感字面量藏过简单 includes 检查。
export function decodeText(s) {
  let d = s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)));
  d = d
    .replace(/\\x([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)));
  return s + '\n' + d;
}

// relPath: 仅用于报错信息；text: 待扫描原文；opts.literals / opts.regexes 为追加项。
export function scanLeak(relPath, text, { literals = [], regexes = [] } = {}) {
  const probe = decodeText(text);
  const allLit = [...DEFAULT_LITERALS, ...literals];
  for (const lit of allLit) {
    for (const enc of ['utf8', 'utf16le']) {
      if (Buffer.from(probe, enc).includes(Buffer.from(lit, enc))) {
        throw new Error(`[泄漏扫描] ${relPath} 命中私有字面量: ${lit}`);
      }
    }
  }
  const allRe = [...DEFAULT_REGEXES, ...regexes];
  for (const re of allRe) {
    if (re.test(probe)) throw new Error(`[泄漏扫描] ${relPath} 命中私有正则: ${re}`);
  }
}
