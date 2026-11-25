// SPDX-License-Identifier: Apache-2.0
// @feature DOC1 @scenario S-01 S-02
// 零外部依赖静态语法着色器：逐字符切分并仅包裹 <span class="tok-*">，
// 保证 DOM textContent 与输入源码逐字一致（含首尾空白与 \r\n）。

const escapeHtml = (value) => value.replace(/[&<>"'\r]/g, (ch) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '\r': '&#13;',
})[ch]);

const span = (cls, raw) => `<span class="tok-${cls}">${escapeHtml(raw)}</span>`;

function scanAlternation(code, rules) {
  const parts = [];
  let cursor = 0;
  const master = new RegExp(
    rules.map((r, idx) => `(?<g${idx}>${r.re.source})`).join('|'),
    'g',
  );
  for (const match of code.matchAll(master)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push(escapeHtml(code.slice(cursor, start)));
    let matched = false;
    for (let idx = 0; idx < rules.length; idx += 1) {
      const value = match.groups?.[`g${idx}`];
      if (value !== undefined) {
        parts.push(rules[idx].render ? rules[idx].render(value) : span(rules[idx].cls, value));
        matched = true;
        break;
      }
    }
    if (!matched) parts.push(escapeHtml(match[0]));
    cursor = start + match[0].length;
  }
  if (cursor < code.length) parts.push(escapeHtml(code.slice(cursor)));
  return parts.join('');
}

const SHELL_KEYWORDS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'node', 'git', 'codex', 'claude', 'codebuddy',
  'kimi', 'python3', 'cd', 'ls', 'cat', 'mkdir', 'cp', 'mv', 'rm', 'echo',
  'export', 'source', 'if', 'then', 'else', 'fi', 'for', 'in', 'do', 'done',
  'artifact-graph', 'release-skill', 'skill-family-doc-render', 'skill-family-kit',
]);

const JS_KEYWORDS = new Set([
  'import', 'export', 'from', 'as', 'default', 'const', 'let', 'var',
  'function', 'async', 'await', 'return', 'if', 'else', 'for', 'of', 'in',
  'while', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally',
  'throw', 'new', 'class', 'extends', 'typeof', 'instanceof', 'true', 'false',
  'null', 'undefined', 'type', 'interface',
]);

const SHELL_RULES = [
  { cls: 'comment', re: /#[^\n\r]*/ },
  { cls: 'string', re: /"(?:\\.|[^"\\\r\n])*"|'(?:[^'\r\n])*'/ },
  { cls: 'var', re: /\$\{[A-Za-z0-9_]+\}|\$[A-Za-z_][A-Za-z0-9_]*|@[A-Z0-9_]+@/ },
  { cls: 'flag', re: /(?:^|(?<=[\s=]))--?[A-Za-z0-9][A-Za-z0-9_-]*/ },
  {
    cls: 'keyword',
    re: /\b[A-Za-z][A-Za-z0-9_-]*\b/,
    render: (word) => (SHELL_KEYWORDS.has(word) ? span('keyword', word) : escapeHtml(word)),
  },
];

const JSON_RULES = [
  { cls: 'comment', re: /\/\/[^\n\r]*|\/\*[\s\S]*?\*\// },
  {
    cls: 'key',
    re: /"(?:\\.|[^"\\\r\n])*"(?=\s*:)/,
  },
  { cls: 'string', re: /"(?:\\.|[^"\\\r\n])*"/ },
  { cls: 'keyword', re: /\b(?:true|false|null)\b/ },
  { cls: 'number', re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/ },
];

const YAML_RULES = [
  { cls: 'comment', re: /#[^\n\r]*/ },
  { cls: 'string', re: /"(?:\\.|[^"\\\r\n])*"|'(?:''|[^'\r\n])*'/ },
  { cls: 'key', re: /(?:^|(?<=[\n\r]))\s*-?\s*[A-Za-z0-9_.-]+(?=\s*:)/ },
  { cls: 'keyword', re: /\b(?:true|false|null|yes|no)\b/ },
  { cls: 'number', re: /-?\b\d+(?:\.\d+)?\b/ },
];

const JS_RULES = [
  { cls: 'comment', re: /\/\/[^\n\r]*|\/\*[\s\S]*?\*\// },
  { cls: 'string', re: /"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|`(?:\\.|[^`\\])*`/ },
  { cls: 'var', re: /@[A-Z0-9_]+@/ },
  {
    cls: 'keyword',
    re: /\b[A-Za-z_$][A-Za-z0-9_$]*\b/,
    render: (word) => (JS_KEYWORDS.has(word) ? span('keyword', word) : escapeHtml(word)),
  },
  { cls: 'number', re: /\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b/ },
];

const MARKDOWN_RULES = [
  { cls: 'keyword', re: /(?:^|(?<=[\n\r]))(?:#{1,6}\s+[^\n\r]*|:::[a-z-]+[^\n\r]*|:::)/ },
  { cls: 'string', re: /`[^`\r\n]+`/ },
  { cls: 'var', re: /@[A-Z0-9_]+@/ },
];

export function highlightCode(language, text) {
  const lang = String(language || 'text').toLowerCase();
  if (['bash', 'sh', 'shell', 'zsh', 'console'].includes(lang)) return scanAlternation(text, SHELL_RULES);
  if (['json', 'jsonc'].includes(lang)) return scanAlternation(text, JSON_RULES);
  if (['yaml', 'yml'].includes(lang)) return scanAlternation(text, YAML_RULES);
  if (['js', 'mjs', 'cjs', 'javascript', 'ts', 'tsx', 'typescript'].includes(lang)) return scanAlternation(text, JS_RULES);
  if (['md', 'markdown'].includes(lang)) return scanAlternation(text, MARKDOWN_RULES);
  return escapeHtml(text);
}
