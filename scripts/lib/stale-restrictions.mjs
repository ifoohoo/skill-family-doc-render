// SPDX-License-Identifier: Apache-2.0
// @feature DOC2 @scenario S-05
// 静态一致性检查（US-070）：比对 SKILL.md 与说明文档中的否定性限制表述及失效引用，
// 与 project.json、宿主清单、Schema 及 CLI 真实已开放能力对照，输出精确行号与中文修正建议。
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { readFileContained, resolveContained } from 'skill-family-harness-node';

export class StaleRestrictionsError extends Error {
  constructor(findings, summary) {
    super(summary);
    this.findings = findings;
  }
}

const HOST_ALIAS_TABLE = Object.freeze({
  claude: ['claude', 'claude-code', 'claude code'],
  'claude-code': ['claude', 'claude-code', 'claude code'],
  codex: ['codex', 'openai codex'],
  'kimi-code': ['kimi', 'kimi-code', 'kimi code'],
  kimi: ['kimi', 'kimi-code', 'kimi code'],
  workbuddy: ['workbuddy'],
  codebuddy: ['codebuddy', 'codebuddy cli'],
  antigravity: ['antigravity'],
  qoder: ['qoder'],
});

const IGNORED_DIRS = new Set([
  '.git', 'node_modules', '.codex', '.workbuddy', '.release-skill', '.artifact-graph',
  'evidence', 'examples', 'test', 'tests', 'work', 'rendered',
]);

function normalizeHostKey(raw) {
  const lower = String(raw || '').trim().toLowerCase();
  if (lower === 'claude-code' || lower === 'claude') return 'claude';
  if (lower === 'kimi' || lower === 'kimi-code') return 'kimi-code';
  return lower;
}

function hostDisplayName(canonical) {
  const names = {
    claude: 'Claude Code',
    codex: 'Codex',
    'kimi-code': 'Kimi Code',
    workbuddy: 'WorkBuddy',
    codebuddy: 'CodeBuddy',
    antigravity: 'Antigravity',
    qoder: 'Qoder',
  };
  return names[canonical] || canonical;
}

function parseSemver(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isOlderSemver(candidate, baseline) {
  const a = parseSemver(candidate);
  const b = parseSemver(baseline);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

async function walkFiles(rootAbs, currentAbs = rootAbs, out = []) {
  for (const entry of (await readdir(currentAbs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = join(currentAbs, entry.name);
    const rel = relative(rootAbs, full).replaceAll('\\', '/');
    if (rel.startsWith('docs/plans/') || rel.startsWith('docs/handoffs/') || rel.startsWith('docs/reports/') || rel.startsWith('docs/specs/') || rel.startsWith('docs/design/')) {
      continue;
    }
    if (entry.isDirectory()) await walkFiles(rootAbs, full, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

async function readJsonSafe(rootAbs, relPath) {
  try {
    return JSON.parse(await readFileContained(rootAbs, relPath, { encoding: 'utf8' }));
  } catch {
    return null;
  }
}

export async function extractOpenCapabilities(workspaceRoot) {
  const rootAbs = resolve(workspaceRoot);
  const allFiles = await walkFiles(rootAbs);
  const hosts = new Map();
  const cliFlags = new Map();
  const cliBins = new Set();
  const binEntryFiles = new Set();
  const cliPackagePrefixes = new Set();
  const subcommands = new Map();
  const formats = new Map();
  let maxVersion = '0.0.0';

  const registerHost = (rawId, evidence) => {
    if (!rawId || typeof rawId !== 'string') return;
    const key = normalizeHostKey(rawId);
    if (!key) return;
    const aliases = new Set([key, rawId.toLowerCase(), ...(HOST_ALIAS_TABLE[key] || []), ...(HOST_ALIAS_TABLE[rawId.toLowerCase()] || [])]);
    const existing = hosts.get(key);
    if (existing) aliases.forEach((item) => existing.aliases.add(item));
    else hosts.set(key, { id: key, label: hostDisplayName(key), aliases, evidence });
  };

  for (const rel of allFiles) {
    if (rel === 'package.json' || /^(?:packages|plugins)\/[^/]+\/package\.json$/.test(rel)) {
      const pkg = await readJsonSafe(rootAbs, rel);
      if (pkg?.version && isOlderSemver(maxVersion, pkg.version)) maxVersion = pkg.version;
      const pkgBaseDir = rel === 'package.json' ? '.' : posix.dirname(rel);
      const pkgPrefix = rel === 'package.json' ? '' : `${posix.dirname(rel)}/`;
      const registerBinTarget = (rawTarget) => {
        if (typeof rawTarget !== 'string' || !rawTarget.trim()) return;
        const normalized = posix.normalize(posix.join(pkgBaseDir, rawTarget.trim().replaceAll('\\', '/')));
        if (!normalized.startsWith('..') && /\.(?:mjs|js|ts|py)$/.test(normalized)) {
          binEntryFiles.add(normalized);
          cliPackagePrefixes.add(pkgPrefix);
        }
      };
      if (typeof pkg?.bin === 'string' && pkg.bin.trim()) {
        if (typeof pkg?.name === 'string' && pkg.name.trim()) {
          cliBins.add(pkg.name.trim().replace(/^@[^/]+\//, ''));
        }
        registerBinTarget(pkg.bin);
      } else if (pkg?.bin && typeof pkg.bin === 'object') {
        for (const [binName, binTarget] of Object.entries(pkg.bin)) {
          if (binName.trim()) cliBins.add(binName.trim());
          registerBinTarget(binTarget);
        }
      }
    }
    if (rel === 'project.json' || rel.endsWith('/project.json') || rel === 'skill-family.project-manifest.json') {
      const doc = await readJsonSafe(rootAbs, rel);
      for (const list of [doc?.hosts, doc?.supportedHosts, doc?.platforms]) {
        if (Array.isArray(list)) list.forEach((h) => registerHost(typeof h === 'string' ? h : h?.id || h?.hostId, rel));
      }
      for (const binCandidate of [doc?.cliName, doc?.cliBin, ...(Array.isArray(doc?.cliBins) ? doc.cliBins : [])]) {
        if (typeof binCandidate === 'string' && binCandidate.trim()) cliBins.add(binCandidate.trim());
      }
      if (Array.isArray(doc?.commands || doc?.subcommands)) {
        for (const cmd of (doc.commands || doc.subcommands)) {
          const name = typeof cmd === 'string' ? cmd : cmd?.name;
          if (name) subcommands.set(name, { evidence: rel });
        }
      }
      if (Array.isArray(doc?.cliFlags)) {
        for (const flag of doc.cliFlags) if (typeof flag === 'string') cliFlags.set(flag, { evidence: rel });
      }
    }
    if (rel.endsWith('/platform-manifest.json')) {
      const doc = await readJsonSafe(rootAbs, rel);
      if (doc?.platformId) registerHost(doc.platformId, rel);
    }
    const pluginDirMatch = /(?:^|\/)\.(claude|codex|kimi|codebuddy)-plugin\/plugin\.json$/.exec(rel);
    if (pluginDirMatch) registerHost(pluginDirMatch[1], rel);
    if (rel === 'plugin.json' || /^(?:packages|plugins)\/[^/]+\/plugin\.json$/.test(rel)) {
      const rootManifest = await readJsonSafe(rootAbs, rel);
      if (rootManifest && typeof rootManifest.name === 'string' && rootManifest.name.trim()) {
        registerHost('antigravity', rel);
      }
    }

    if (rel.endsWith('.schema.json')) {
      const text = await readFileContained(rootAbs, rel, { encoding: 'utf8' });
      for (const item of ['markdown-v1', 'markdown-v2', 'editorial', 'modern']) {
        if (text.includes(`"${item}"`) && !formats.has(item)) formats.set(item, { evidence: rel });
      }
    }
  }

  const isCliSourceFile = (rel) => {
    if (rel.includes('/adapters/')) return false;
    if (binEntryFiles.has(rel)) return true;
    if (/^(?:(?:packages|plugins)\/[^/]+\/)?(?:bin|scripts)\/.*\.(?:mjs|js|ts|py)$/.test(rel)) return true;
    if (/\.(?:mjs|js|ts|py)$/.test(rel)) {
      for (const prefix of cliPackagePrefixes) {
        if (rel.startsWith(`${prefix}src/`)) return true;
      }
    }
    return false;
  };

  for (const rel of allFiles) {
    if (!isCliSourceFile(rel)) continue;
    const text = await readFileContained(rootAbs, rel, { encoding: 'utf8' });
    const withoutComments = rel.endsWith('.py')
      ? text.replace(/#.*$/gm, '')
      : text
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
    for (const match of withoutComments.matchAll(/(?:['"`]|[\s(,|])(--[a-z][a-z0-9-]+)(?=$|[\s'"`=,)|\]}])/gm)) {
      if (!cliFlags.has(match[1])) cliFlags.set(match[1], { evidence: rel });
    }
    if (withoutComments.includes('parseArgs')) {
      for (const optKey of withoutComments.matchAll(/(?:^|[,{\n])\s*(['"]?)([a-z][a-z0-9-]*)\1\s*:\s*\{\s*type\s*:\s*['"](?:boolean|string)['"]/g)) {
        const flag = `--${optKey[2]}`;
        if (!cliFlags.has(flag)) cliFlags.set(flag, { evidence: rel });
      }
    }
  }

  return {
    maxVersion,
    hosts: new Map([...hosts.entries()].map(([k, v]) => [k, { ...v, aliases: [...v.aliases] }])),
    cliFlags,
    cliBins: [...cliBins].sort(),
    subcommands,
    formats,
  };
}

function hasOlderHistoricalVersion(clause, maxVersion) {
  for (const match of clause.matchAll(/\b(\d+\.\d+\.\d+)\b/g)) {
    if (isOlderSemver(match[1], maxVersion)) return true;
  }
  if (/\b0\.[0-5]\.x\b|\bv1\s*规格|\b旧(?:版本|格式|规格|HTML)|兼容(?:模式|路径|入口)|历史(?:规格|候选|用法)/i.test(clause)) {
    return true;
  }
  return false;
}

function isScopedHostBoundary(clause) {
  return /(?:registry|自动解析|方法解析|表达解析|子智能体|斜杠菜单|自定义\s*adapter\s*路径|lacks\s+|published\s+\d)/i.test(clause);
}

function isFlagCombinationConstraint(clause) {
  return /(?:互斥|不能与|不可与|不得与|不能同时|禁止与|cannot be combined|mutually exclusive|only valid with|只能与)/i.test(clause);
}

function stripFencedAndComments(markdown) {
  const masked = markdown.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
  const lines = masked.split('\n');
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      return '';
    }
    return inFence ? '' : line;
  });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SHELL_FENCE_LANGS = new Set(['', 'sh', 'bash', 'zsh', 'shell', 'console']);

function isNegativeOrHistoricalFlagMention(line, maxVersion) {
  if (hasOlderHistoricalVersion(line, maxVersion)) return true;
  return /(?:不支持|不存在|已移除|已删除|已废弃|已下线|虚构|未知选项|非法选项|报错|错误示例|严禁|切勿|不得编造|禁止编造)/.test(line);
}

function scanHallucinatedCliFlags(rawMarkdown, rel, capabilities, findings) {
  if (!capabilities.cliBins?.length || capabilities.cliFlags.size === 0) return;
  const masked = rawMarkdown.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
  const rawLines = masked.split('\n');
  const defaultEvidence = [...capabilities.cliFlags.values()][0]?.evidence || 'bin/';
  const validListPreview = [...capabilities.cliFlags.keys()].sort().join(', ');
  const isSiteDoc = /(?:^|\/)(?:site|site-src)\/.*\.md$/.test(rel);

  let inFence = false;
  let fenceMarker = '';
  let fenceLang = '';
  let inCliFlagTable = false;
  const reportedOnLine = new Set();

  const recordFinding = (lineNo, flag, excerpt, contextLabel) => {
    const dedupKey = `${lineNo}:${flag}`;
    if (reportedOnLine.has(dedupKey)) return;
    reportedOnLine.add(dedupKey);
    findings.push({
      file: rel,
      line: lineNo,
      kind: 'hallucinated-cli-flag',
      capability: flag,
      excerpt: excerpt.trim().slice(0, 120),
      evidence: defaultEvidence,
      suggestion: `${contextLabel}出现了未实现的 CLI 选项 ${flag}（当前已开放长选项：${validListPreview}），请核对 CLI --help 与参数解析源码并移除虚构参数。`,
    });
  };

  for (let idx = 0; idx < rawLines.length; idx += 1) {
    const lineNo = idx + 1;
    const line = rawLines[idx];
    const fenceMatch = /^\s*(`{3,}|~{3,})([^\n]*)$/.exec(line);
    if (fenceMatch && !(fenceMatch[1][0] === '`' && fenceMatch[2].includes('`'))) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1];
        fenceLang = fenceMatch[2].trim().split(/\s+/)[0].toLowerCase();
        inCliFlagTable = false;
        continue;
      }
      if (line.trim().startsWith(fenceMarker[0].repeat(fenceMarker.length)) && /^\s*[`~]+\s*$/.test(line)) {
        inFence = false;
        fenceMarker = '';
        fenceLang = '';
        continue;
      }
    }

    if (inFence) {
      if (!SHELL_FENCE_LANGS.has(fenceLang)) continue;
      if (/^\s*#/.test(line)) continue;
    }

    if (!inFence) {
      if (/^\s*\|/.test(line)) {
        const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
        const firstClean = cells[0]?.replace(/[`*_]/g, '').trim() || '';
        const isSep = cells.every((c) => /^:?-{2,}:?$/.test(c));
        if (!inCliFlagTable && /^(?:参数|选项|命令行参数|命令行选项|CLI\s*参数|CLI\s*选项|常用参数|附加参数|Flag|Flags|Option|Options)$/i.test(firstClean)) {
          inCliFlagTable = isSiteDoc;
          continue;
        }
        if (inCliFlagTable && !isSep && cells.length >= 2 && !hasOlderHistoricalVersion(line, capabilities.maxVersion) && !/(?:已移除|已删除|已废弃|已下线)/.test(line)) {
          for (const m of cells[0].matchAll(/(?<![A-Za-z0-9-])(--[a-z][a-z0-9-]+)(?![A-Za-z0-9-])/g)) {
            if (!capabilities.cliFlags.has(m[1])) {
              recordFinding(lineNo, m[1], line, 'CLI 参数表首列');
            }
          }
        }
      } else {
        inCliFlagTable = false;
      }
    }

    if (isNegativeOrHistoricalFlagMention(line, capabilities.maxVersion)) continue;

    for (const binName of capabilities.cliBins) {
      const invokeRe = new RegExp(
        `(?:^|[\\s\`(])(?:(?:npx|pnpx)\\s+(?:--yes\\s+|-y\\s+)?|pnpm\\s+(?:dlx|exec)\\s+|npm\\s+exec\\s+(?:--\\s+)?|node\\s+[^\\s\`]*\\/)?${escapeRegExp(binName)}(?:\\.mjs)?(?:@[A-Za-z0-9._-]+|@@[A-Z0-9_]+@)?\\s+([^\\n\`#;|>&]+)`,
        'g',
      );
      for (const inv of line.matchAll(invokeRe)) {
        const beforeDoubleDash = inv[1].split(/\s+--(?:\s|$)/)[0];
        for (const fm of beforeDoubleDash.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]+)(?=$|[\s=])/g)) {
          if (!capabilities.cliFlags.has(fm[1])) {
            recordFinding(lineNo, fm[1], line, `命令 ${binName} 调用中`);
          }
        }
      }
    }
  }
}

function hostMentionedIn(text, hostInfo) {
  return hostInfo.aliases.some((alias) => {
    const pattern = /^[a-z0-9 -]+$/i.test(alias)
      ? new RegExp(`(?<![a-z0-9-])${escapeRegExp(alias)}(?![a-z0-9-])`, 'i')
      : new RegExp(escapeRegExp(alias), 'i');
    return pattern.test(text);
  });
}

async function defaultDocTargets(rootAbs) {
  const allFiles = await walkFiles(rootAbs);
  return allFiles.filter((rel) => {
    if (rel.includes('/adapters/')) return false;
    if (rel === 'README.md' || rel === 'docs/public/README.md') return true;
    if (/^packages\/[^/]+\/README\.md$/.test(rel)) return true;
    if (/^(?:packages\/[^/]+\/)?skills\/.*\.md$/.test(rel)) return true;
    if (/^(?:packages\/[^/]+\/)?(?:site|site-src|docs\/site|docs\/public\/site)\/.*\.md$/.test(rel)) return true;
    return false;
  });
}

export async function checkStaleRestrictions({ workspaceRoot, docPaths } = {}) {
  const rootAbs = resolve(workspaceRoot);
  if (!existsSync(rootAbs) || !(await stat(rootAbs)).isDirectory()) {
    throw new TypeError(`工作区根目录不存在: ${rootAbs}`);
  }
  const capabilities = await extractOpenCapabilities(rootAbs);
  const targets = docPaths
    ? docPaths.map((p) => posix.normalize(p.replaceAll('\\', '/')))
    : await defaultDocTargets(rootAbs);

  const findings = [];
  for (const rel of targets) {
    await resolveContained(rootAbs, rel);
    const raw = await readFileContained(rootAbs, rel, { encoding: 'utf8' });
    scanHallucinatedCliFlags(raw, rel, capabilities, findings);
    const lines = stripFencedAndComments(raw);
    const isSkillTreeDoc = /(?:^|\/)skills\//.test(rel);

    lines.forEach((lineText, index) => {
      const lineNumber = index + 1;
      if (!lineText.trim()) return;

      const clauses = lineText.split(/(?<=[。！？；\n])|;\s+/);
      for (const rawClause of clauses) {
        const clause = rawClause.trim();
        if (!clause) continue;
        const historical = hasOlderHistoricalVersion(clause, capabilities.maxVersion);

        if (!historical && !isScopedHostBoundary(clause)) {
          for (const host of capabilities.hosts.values()) {
            const negHostRe = new RegExp(
              `(?:(?:暂不|尚不|目前不|当前不|还不|不再|未|不)(?:支持|兼容|适配|开放|提供)[^，。；\\n]{0,18})|(?<=${escapeRegExp(host.aliases[0])})[^，。；\\n]{0,12}(?:暂不支持|尚不支持|未支持|不兼容|未适配)`,
              'i',
            );
            if (hostMentionedIn(clause, host) && /(?:暂不|尚不|目前不|当前不|还不|未|不)(?:支持|兼容|适配|开放)/.test(clause) && negHostRe.test(clause)) {
              findings.push({
                file: rel,
                line: lineNumber,
                kind: 'stale-host-restriction',
                capability: host.label,
                excerpt: clause.slice(0, 120),
                evidence: host.evidence,
                suggestion: `宿主 ${host.label} 已在 ${host.evidence} 中开放支持，请移除过时的“不支持”限制或改为说明具体子功能边界。`,
              });
            }
          }
          const onlySupportMatch = /^(?:本插件|本技能族|本技能|插件|当前版本|目前)?\s*(?:仅支持|只支持|仅适配|只适配)\s*([^。；\n]{2,60}?)(?:宿主|平台|客户端)/.exec(clause);
          if (onlySupportMatch && capabilities.hosts.size > 1) {
            const mentioned = [...capabilities.hosts.values()].filter((h) => hostMentionedIn(onlySupportMatch[1], h));
            if (mentioned.length > 0 && mentioned.length < capabilities.hosts.size) {
              const omitted = [...capabilities.hosts.values()].filter((h) => !mentioned.includes(h));
              findings.push({
                file: rel,
                line: lineNumber,
                kind: 'stale-host-restriction',
                capability: omitted.map((h) => h.label).join(', '),
                excerpt: clause.slice(0, 120),
                evidence: omitted[0].evidence,
                suggestion: `清单已开放 ${[...capabilities.hosts.values()].map((h) => h.label).join('、')}，请勿在全局宿主范围写“仅支持部分宿主”（已遗漏：${omitted.map((h) => h.label).join('、')}）。`,
              });
            }
          }
        }

        if (!historical && !isFlagCombinationConstraint(clause)) {
          for (const [flag, meta] of capabilities.cliFlags.entries()) {
            const escaped = escapeRegExp(flag);
            const beforeNeg = new RegExp(`(?:暂不|尚不|目前不|当前不|还不|尚未|未|不)(?:支持|提供|实现|开放|包含)[^。；\\n]{0,28}?${escaped}(?![a-z0-9-])`, 'i');
            const afterNeg = new RegExp(`${escaped}(?![a-z0-9-])[^。；\\n]{0,18}?(?:暂不支持|尚不支持|目前不支持|当前不支持|尚未实现|未实现|尚未开放|不可用)`, 'i');
            const enNeg = new RegExp(`(?:does not support|not supported|unsupported|lacks)\\s+[^.;\\n]{0,24}?${escaped}(?![a-z0-9-])`, 'i');
            if (beforeNeg.test(clause) || afterNeg.test(clause) || enNeg.test(clause)) {
              findings.push({
                file: rel,
                line: lineNumber,
                kind: 'stale-cli-restriction',
                capability: flag,
                excerpt: clause.slice(0, 120),
                evidence: meta.evidence,
                suggestion: `CLI 参数 ${flag} 已在 ${meta.evidence} 中开放实现，请将旧限制更新为当前用法或注明仅限历史旧版。`,
              });
            }
          }
          for (const [cmd, meta] of capabilities.subcommands.entries()) {
            const escaped = escapeRegExp(cmd);
            const cmdNeg = new RegExp(`(?:暂不|尚不|目前不|当前不|还不|尚未|未)(?:支持|提供|实现|开放)[^。；\\n]{0,20}?(?:子命令|命令)\\s*\`?${escaped}\`?|(?:\`?${escaped}\`?\\s*子命令)[^。；\\n]{0,16}?(?:暂不支持|尚不支持|未实现|不可用)`, 'i');
            if (cmdNeg.test(clause)) {
              findings.push({
                file: rel,
                line: lineNumber,
                kind: 'stale-cli-restriction',
                capability: cmd,
                excerpt: clause.slice(0, 120),
                evidence: meta.evidence,
                suggestion: `子命令 ${cmd} 已在 ${meta.evidence} 中开放，请删除过时的不支持限制。`,
              });
            }
          }
          for (const [fmt, meta] of capabilities.formats.entries()) {
            const escaped = escapeRegExp(fmt);
            const fmtNeg = new RegExp(`(?:暂不|尚不|目前不|当前不|还不|尚未|未)(?:支持|提供|实现|开放)[^。；\\n]{0,20}?${escaped}|${escaped}[^。；\\n]{0,16}?(?:暂不支持|尚不支持|未实现|尚未开放)`, 'i');
            if (fmtNeg.test(clause)) {
              findings.push({
                file: rel,
                line: lineNumber,
                kind: 'stale-capability-restriction',
                capability: fmt,
                excerpt: clause.slice(0, 120),
                evidence: meta.evidence,
                suggestion: `能力 ${fmt} 已在 ${meta.evidence} 中启用，请移除过时限制表述。`,
              });
            }
          }
        }

        if (!/(?:不再|替代|移除|删除|废弃|历史)/.test(clause) && /脚本拟稿|放入\s*`?--context`?\s*调用|expression-outbound\.mjs/.test(clause)) {
          findings.push({
            file: rel,
            line: lineNumber,
            kind: 'stale-removed-reference',
            capability: 'humanize-rewrite (Registry 委派流程)',
            excerpt: clause.slice(0, 120),
            evidence: 'packages/skill-family-docs/skills/skill-family-docs-style-guard/SKILL.md',
            suggestion: '内嵌脚本拟稿（--context / expression-outbound.mjs）已由独立中文编辑子智能体 + humanize-rewrite Registry 流程替代，请同步更新说明。',
          });
        }

        if (isSkillTreeDoc && !/(?:不再|替代|移除|删除|废弃|历史)/.test(clause)) {
          for (const refMatch of clause.matchAll(/(?:\.\.\/[a-z0-9-]+\/)?(?:references|scripts|agents)\/[A-Za-z0-9._-]+\.(?:md|mjs)/g)) {
            const prefixBefore = clause.slice(0, refMatch.index ?? 0);
            if (/(?:<[^>\s`]+>|\$\{[A-Za-z0-9_]+\})(?:\/[A-Za-z0-9._-]+)*\/$/.test(prefixBefore)) {
              continue;
            }
            const candidateBases = [dirname(resolve(rootAbs, rel))];
            const skillRootMatch = /^((?:(?:packages|plugins)\/[^/]+\/)?skills\/[^/]+)\//.exec(rel);
            if (skillRootMatch) candidateBases.push(resolve(rootAbs, skillRootMatch[1]));
            const pkgRootMatch = /^((?:packages|plugins)\/[^/]+)\//.exec(rel);
            if (pkgRootMatch) candidateBases.push(resolve(rootAbs, pkgRootMatch[1]));
            candidateBases.push(rootAbs);
            const found = candidateBases.some((baseDir) => existsSync(resolve(baseDir, refMatch[0])));
            if (!found) {
              findings.push({
                file: rel,
                line: lineNumber,
                kind: 'stale-removed-reference',
                capability: refMatch[0],
                excerpt: clause.slice(0, 120),
                evidence: rel,
                suggestion: `引用的技能内部文件 ${refMatch[0]} 已不存在，请改为当前有效参考路径（如 references/components.md 或 references/expression-registry.md）。`,
              });
            }
          }
        }
      }
    });
  }

  return {
    ok: findings.length === 0,
    checkedFiles: targets.length,
    capabilities: {
      maxVersion: capabilities.maxVersion,
      hosts: [...capabilities.hosts.keys()],
      cliBins: capabilities.cliBins,
      cliFlagCount: capabilities.cliFlags.size,
      subcommands: [...capabilities.subcommands.keys()],
      formats: [...capabilities.formats.keys()],
    },
    findings,
  };
}

export function formatStaleRestrictionsReport(result, label = '(workspace)') {
  const lines = [
    `[render-public-site --check-stale-limits] ${label}: 已扫描 ${result.checkedFiles} 份指令与说明文档（已开放宿主: ${result.capabilities.hosts.join(', ') || '无'}；CLI 选项: ${result.capabilities.cliFlagCount} 个）`,
  ];
  if (result.ok) {
    lines.push(`[render-public-site --check-stale-limits] ${label}: 通过，未发现过时限制词或失效内部引用`);
    return lines.join('\n');
  }
  lines.push(`[render-public-site --check-stale-limits] ${label}: 发现 ${result.findings.length} 处过时限制或失效引用:`);
  for (const item of result.findings) {
    lines.push(`  - ${item.file}:L${item.line} [${item.kind}] 能力=${item.capability}`);
    lines.push(`    原文: ${item.excerpt}`);
    lines.push(`    依据: ${item.evidence}`);
    lines.push(`    建议: ${item.suggestion}`);
  }
  return lines.join('\n');
}
