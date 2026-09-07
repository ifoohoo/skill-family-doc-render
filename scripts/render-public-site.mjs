// SPDX-License-Identifier: Apache-2.0
// 通用 GitHub Pages 知识站渲染器（配置驱动，多仓库）。
// 遍历 public-release.json 中所有带 site 字段的 repo，渲染各自站点源到目标目录。
// format 缺省时兼容完整 HTML 注入；显式 markdown-v1 + editorial 时，将受限 Markdown
// 编译为语义块并交给包内统一模板。两条路径共用扫描、基线和原子发布。
// 写盘前对所有产物（页面 + assets）做内容级泄漏扫描（解码后再匹配，防 HTML 实体 /
// JS 反转义 / URL 百分号编码绕过），并 fail-fast 检查未替换的 @TOKEN@ 占位符残留。
//
// 写盘事务化：在 target canonical parent 下创建 sibling staging，全部产物先写入其中，
// 使用 writeFileAtomic；目标不存在时走 createFixedSetPublicationManifest + publishFixedSet，
// 目标存在时走 replaceFixedSetAtomic。提交前失败清理 staging；提交后或状态不确定时保留现场。
// --check 为只读：对内存渲染产物逐文件算 sha256（harness digestBytes）与基线逐文件比对，
// 并把磁盘 target 实际文件清单与 baseline.files 做集合比对，不写任何字节。
//
// harness 化：所有配置 / 源文件读取经 readFileContained，staging 的相对输出经
// writeFileAtomic 收容并原子写入（见 skill-family-harness-node）；树基线摘要用
// computeResourceClosure，逐文件摘要用 digestBytes。
// 配置、pages.json、渲染基线与覆盖快照先经 skill-family-contracts validateDocument
// （JSON Schema 2020-12，strict 策略）校验，校验失败 fail-fast。
//
// 错误分类（退出码语义）：
//   exit 1 — 漂移类：--check 检出漂移、覆盖快照缺失或落后、泄漏扫描命中、
//            --assert-git 缺失、渲染基线缺失 / 基线 JSON 损坏；
//   exit 2 — 配置或工具类：配置 / JSON / 覆盖输入非法、Git 调用失败、
//            @TOKEN@ 占位符残留、markdown-v1/SVG 输入非法、--repo 参数无效；
//   其余意外异常（HarnessError 等）原样抛出，CLI 归为 exit 1。
//   可预期失败统一封装为 RenderError 携带 exitCode。
import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir, rm, mkdtemp, realpath, stat, glob } from 'node:fs/promises';
import { resolve, relative, extname, join, dirname, basename, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  resolveContained,
  classifyPathInput,
  readFileContained,
  digestBytes,
  computeResourceClosure,
  writeFileAtomic,
  createFixedSetPublicationManifest,
  publishFixedSet,
  replaceFixedSetAtomic,
} from 'skill-family-harness-node';
import { validateDocument } from 'skill-family-contracts';
import { scanLeak, LeakScanError } from './lib/leak-scan.mjs';
import { compileMarkdownV1, replaceMarkdownTokens } from './lib/markdown-v1.mjs';
import { assertSafeSvg } from './lib/svg-safety.mjs';
import { checkRenderedLinks } from './lib/rendered-links.mjs';
import { renderEditorialSite } from '../templates/editorial/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 包内 schema（渲染器自身资源，不属于工作区文件，直接读取）
const publicReleaseSchema = JSON.parse(
  readFileSync(join(__dirname, '..', 'schemas', 'public-release.schema.json'), 'utf8'),
);
const siteBaselineSchema = JSON.parse(
  readFileSync(join(__dirname, '..', 'schemas', 'site-baseline.schema.json'), 'utf8'),
);
const siteCoverageLockSchema = JSON.parse(
  readFileSync(join(__dirname, '..', 'schemas', 'site-coverage-lock.schema.json'), 'utf8'),
);
const pagesSchema = JSON.parse(
  readFileSync(join(__dirname, '..', 'schemas', 'pages.schema.json'), 'utf8'),
);

// 可预期失败（配置缺失、校验失败、check 漂移、泄漏命中等）以此类型抛出，携带退出码。
export class RenderError extends Error {
  constructor(message, exitCode = 2, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.exitCode = exitCode;
  }
}

function assertValid(doc, schema, label) {
  const { valid, errors } = validateDocument(doc, { schema, dialect: '2020-12', policy: 'strict' });
  if (!valid) {
    const detail = errors.map((e) => `${e.instancePath || '(root)'}: ${e.message}`).join('; ');
    throw new RenderError(`[render-public-site] ${label} 校验失败: ${detail}`, 2);
  }
}

// JSON 解析失败属于配置类错误：包装为 RenderError(exit 2)，其余异常原样抛出。
async function readJsonContained(root, rel, label, name) {
  try {
    return JSON.parse(await readFileContained(root, rel, { encoding: 'utf8' }));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new RenderError(`[render-public-site] ${name}: ${label} JSON 解析失败: ${err.message}`, 2);
    }
    throw err;
  }
}

function tokenName(name) {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

async function pkgVersion(root, source, name) {
  const pkgRel = join(source, 'package.json');
  const fallback = (why) => {
    console.warn(
      `[render-public-site] WARNING: ${name}: ${why}，版本回退 0.0.0（将烤进产物与基线，请确认是否有意为之）`,
    );
    return '0.0.0';
  };
  if (!existsSync(resolve(root, pkgRel))) {
    return fallback(`未找到 ${pkgRel}`);
  }
  const doc = await readJsonContained(root, pkgRel, 'package.json', name);
  if (!doc || typeof doc.version !== 'string' || !doc.version) {
    return fallback(`${pkgRel} 缺少有效 version 字段`);
  }
  return doc.version;
}

function configError(name, message, cause) {
  return new RenderError(`[render-public-site] ${name}: ${message}`, 2, cause);
}

async function repoSourceRoot(root, repo) {
  const classification = classifyPathInput(repo.source);
  if (!classification.ok) {
    throw configError(repo.name, `repo.source 非法 (${classification.kind}): ${repo.source}`);
  }
  if (resolve(root, repo.source) === root) return root;
  try {
    return await resolveContained(root, repo.source);
  } catch (cause) {
    throw configError(repo.name, `repo.source 未收容于工作区: ${repo.source}`, cause);
  }
}

async function containedOrConfig(root, relPath, repoName, fieldPath) {
  try {
    return await resolveContained(root, relPath);
  } catch (cause) {
    throw configError(repoName, `${fieldPath} 必须是收容于 repo.source 的相对路径: ${relPath}`, cause);
  }
}

function jsonPointerValue(document, pointer, repoName, fieldPath) {
  const segments = pointer.slice(1).split('/').map((segment) => {
    if (/~(?:[^01]|$)/.test(segment)) {
      throw configError(repoName, `${fieldPath} 不是有效 JSON Pointer: ${pointer}`);
    }
    return segment.replaceAll('~1', '/').replaceAll('~0', '~');
  });
  let value = document;
  for (const segment of segments) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) {
      throw configError(repoName, `${fieldPath} 指向的字段不存在: ${pointer}`);
    }
    value = value[segment];
  }
  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    throw configError(repoName, `${fieldPath} 必须指向 string、number 或 boolean: ${pointer}`);
  }
  return value;
}

async function loadVersionSources(sourceRoot, repo) {
  const definitions = repo.site.versionSources || {};
  const cache = new Map();
  const tokens = {};
  const values = [];
  const paths = new Set();
  for (const [token, definition] of Object.entries(definitions)) {
    const fieldPath = `site.versionSources.${token}`;
    const sourceAbs = await containedOrConfig(sourceRoot, definition.source, repo.name, `${fieldPath}.source`);
    let sourceStats;
    try {
      sourceStats = await stat(sourceAbs);
    } catch (cause) {
      throw configError(repo.name, `${fieldPath}.source 不可读取: ${definition.source}`, cause);
    }
    if (!sourceStats.isFile()) {
      throw configError(repo.name, `${fieldPath}.source 必须指向 JSON 文件: ${definition.source}`);
    }
    let document = cache.get(definition.source);
    if (document === undefined) {
      try {
        document = JSON.parse(await readFileContained(sourceRoot, definition.source, { encoding: 'utf8' }));
      } catch (cause) {
        if (cause instanceof SyntaxError) {
          throw configError(repo.name, `${fieldPath}.source JSON 解析失败: ${definition.source}: ${cause.message}`, cause);
        }
        throw configError(repo.name, `${fieldPath}.source 读取失败: ${definition.source}`, cause);
      }
      cache.set(definition.source, document);
    }
    const rawValue = jsonPointerValue(document, definition.pointer, repo.name, `${fieldPath}.pointer`);
    const renderedValue = `${definition.prefix || ''}${rawValue}${definition.suffix || ''}`;
    tokens[token] = renderedValue;
    values.push({ token, source: definition.source, pointer: definition.pointer, value: rawValue, renderedValue });
    paths.add(posix.normalize(definition.source.replaceAll('\\', '/')));
  }
  return { tokens, values, paths: [...paths].sort() };
}

async function artifactGraphLockDigest(sourceRoot, repo) {
  const configPath = 'artifact-graph.config.yaml';
  const lockPath = 'artifacts/traceability-version-lock.json';
  const configAbs = await containedOrConfig(sourceRoot, configPath, repo.name, 'artifact-graph config');
  if (!existsSync(configAbs)) return undefined;
  const lockAbs = await containedOrConfig(sourceRoot, lockPath, repo.name, 'artifact-graph version lock');
  if (!existsSync(lockAbs)) {
    throw configError(repo.name, `已启用 artifact-graph，但未找到 ${lockPath}`);
  }
  try {
    return digestBytes(await readFileContained(sourceRoot, lockPath));
  } catch (cause) {
    throw configError(repo.name, `${lockPath} 读取失败`, cause);
  }
}

async function computeCoverageSnapshot(sourceRoot, repo) {
  const coverage = repo.site.coverage;
  if (!coverage) throw configError(repo.name, 'site.coverage 未配置');
  const lockPath = posix.normalize(coverage.lock.replaceAll('\\', '/'));
  await containedOrConfig(sourceRoot, coverage.lock, repo.name, 'site.coverage.lock');
  const versionSources = await loadVersionSources(sourceRoot, repo);
  if (versionSources.paths.includes(lockPath)) {
    throw configError(repo.name, 'site.coverage.lock 不能同时作为版本源');
  }

  const files = new Set();
  for (const [index, pattern] of coverage.inputs.entries()) {
    const fieldPath = `site.coverage.inputs[${index}]`;
    if (pattern.split('/').includes('..')) {
      throw configError(repo.name, `${fieldPath} 不能包含 .. 路径段: ${pattern}`);
    }
    // 首版只接受 * / **，避免 brace、extglob 或字符类先展开再越过收容检查。
    if (/[?\[\]{}()!]/.test(pattern)) {
      throw configError(repo.name, `${fieldPath} 只支持 * 与 ** 通配符: ${pattern}`);
    }
    await containedOrConfig(sourceRoot, pattern.replaceAll('*', '__coverage_glob__'), repo.name, fieldPath);
    const matches = [];
    try {
      for await (const candidate of glob(pattern, { cwd: sourceRoot })) {
        const normalized = posix.normalize(candidate.replaceAll('\\', '/'));
        if (normalized === '.' || normalized === lockPath) continue;
        const candidateAbs = await containedOrConfig(
          sourceRoot,
          normalized,
          repo.name,
          fieldPath,
        );
        const candidateStats = await stat(candidateAbs);
        if (candidateStats.isFile()) matches.push(normalized);
      }
    } catch (cause) {
      if (cause instanceof RenderError) throw cause;
      throw configError(repo.name, `${fieldPath} 无法展开: ${pattern}`, cause);
    }
    if (!matches.length) {
      throw configError(repo.name, `${fieldPath} 没有匹配任何输入文件: ${pattern}`);
    }
    for (const match of matches) files.add(match);
  }
  for (const versionPath of versionSources.paths) {
    await containedOrConfig(sourceRoot, versionPath, repo.name, 'site.versionSources.source');
    files.add(versionPath);
  }

  let closure;
  try {
    closure = await computeResourceClosure({
      root: sourceRoot,
      resources: [...files].sort().map((path) => ({ path, role: 'input' })),
    });
  } catch (cause) {
    throw configError(repo.name, '覆盖输入摘要计算失败', cause);
  }
  const snapshot = {
    sha256: closure.digest,
    inputs: closure.resources.map(({ path, sha256 }) => ({ path, sha256 })),
  };
  const versionLockSha256 = await artifactGraphLockDigest(sourceRoot, repo);
  if (versionLockSha256 !== undefined) {
    snapshot.artifactGraphVersionLockSha256 = versionLockSha256;
  }
  assertValid(snapshot, siteCoverageLockSchema, `${repo.name} site-coverage-lock.json`);
  return { snapshot, versionSources };
}

function git(root, args, repoName) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (cause) {
    const detail = String(cause.stderr || cause.message).trim();
    throw configError(repoName, `Git 命令失败: git ${args.join(' ')}${detail ? `: ${detail}` : ''}`, cause);
  }
}

function splitLines(text) {
  return text ? text.split(/\r?\n/).filter(Boolean) : [];
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function coverageGitStatus(sourceRoot, repo, snapshot, baseline) {
  const gitRoot = git(sourceRoot, ['rev-parse', '--show-toplevel'], repo.name);
  const head = git(sourceRoot, ['rev-parse', 'HEAD'], repo.name);
  const lockAbs = resolve(sourceRoot, repo.site.coverage.lock);
  const lockGitPath = relative(gitRoot, lockAbs).replaceAll('\\', '/');
  const coverageCommit = git(sourceRoot, ['log', '-1', '--format=%H', '--', lockGitPath], repo.name) || null;
  const sourceGitPath = relative(gitRoot, sourceRoot).replaceAll('\\', '/') || '.';
  const knownInputs = new Set([...(baseline?.inputs || []), ...snapshot.inputs].map((entry) => {
    return relative(gitRoot, resolve(sourceRoot, entry.path)).replaceAll('\\', '/');
  }));
  if (snapshot.artifactGraphVersionLockSha256 || baseline?.artifactGraphVersionLockSha256) {
    knownInputs.add(
      relative(gitRoot, resolve(sourceRoot, 'artifacts/traceability-version-lock.json')).replaceAll('\\', '/'),
    );
  }
  const changed = new Set();
  const collect = (lines) => {
    for (const path of lines) if (knownInputs.has(path)) changed.add(path);
  };
  if (coverageCommit) {
    collect(splitLines(git(sourceRoot, ['diff', '--name-only', '--no-renames', `${coverageCommit}..${head}`], repo.name)));
  } else {
    for (const path of knownInputs) changed.add(path);
  }
  collect(splitLines(git(sourceRoot, ['diff', '--cached', '--name-only', '--no-renames'], repo.name)));
  collect(splitLines(git(sourceRoot, ['diff', '--name-only', '--no-renames'], repo.name)));
  collect(splitLines(git(sourceRoot, ['ls-files', '--others', '--exclude-standard'], repo.name)));

  const suggestions = coverageCommit
    ? [
        `git diff ${coverageCommit}..HEAD -- ${shellQuote(sourceGitPath)}`,
        `git diff --cached -- ${shellQuote(sourceGitPath)}`,
        `git diff -- ${shellQuote(sourceGitPath)}`,
      ]
    : [
        `git status --short -- ${shellQuote(sourceGitPath)}`,
        `git diff HEAD -- ${shellQuote(sourceGitPath)}`,
      ];
  return { coverageCommit, changed: [...changed].sort(), suggestions };
}

async function readCoverageBaseline(sourceRoot, repo) {
  const lockPath = repo.site.coverage.lock;
  const lockAbs = await containedOrConfig(sourceRoot, lockPath, repo.name, 'site.coverage.lock');
  if (!existsSync(lockAbs)) return null;
  let baseline;
  try {
    baseline = JSON.parse(await readFileContained(sourceRoot, lockPath, { encoding: 'utf8' }));
  } catch (cause) {
    throw configError(repo.name, `覆盖快照 JSON 解析失败: ${lockPath}: ${cause.message}`, cause);
  }
  assertValid(baseline, siteCoverageLockSchema, `${repo.name} site-coverage-lock.json`);
  return baseline;
}

async function refreshCoverageLock(root, repo) {
  const sourceRoot = await repoSourceRoot(root, repo);
  // 已存在的写入目标必须已经是覆盖快照，避免错误配置把普通项目文件当作锁覆盖。
  await readCoverageBaseline(sourceRoot, repo);
  const { snapshot } = await computeCoverageSnapshot(sourceRoot, repo);
  try {
    await writeFileAtomic(sourceRoot, repo.site.coverage.lock, `${JSON.stringify(snapshot, null, 2)}\n`);
  } catch (cause) {
    throw configError(repo.name, `覆盖快照写入失败: ${repo.site.coverage.lock}`, cause);
  }
  console.log(`[render-public-site --refresh-coverage] ${repo.name}: 已写入 ${repo.site.coverage.lock}`);
  console.log(`[render-public-site --refresh-coverage] ${repo.name}: coverage-sha256=${snapshot.sha256}`);
}

async function reportCoverageStatus(root, repo) {
  if (!repo.site.coverage) throw configError(repo.name, 'site.coverage 未配置');
  const sourceRoot = await repoSourceRoot(root, repo);
  const baseline = await readCoverageBaseline(sourceRoot, repo);
  const { snapshot, versionSources } = await computeCoverageSnapshot(sourceRoot, repo);
  const gitStatus = coverageGitStatus(sourceRoot, repo, snapshot, baseline);
  const consistent = baseline !== null
    && baseline.sha256 === snapshot.sha256
    && JSON.stringify(baseline.inputs) === JSON.stringify(snapshot.inputs)
    && baseline.artifactGraphVersionLockSha256 === snapshot.artifactGraphVersionLockSha256;
  const state = baseline === null ? '缺失' : consistent ? '一致' : '落后';
  console.log(`[render-public-site --status] ${repo.name}: ${state}`);
  console.log(`  覆盖提交: ${gitStatus.coverageCommit || '（覆盖快照尚未提交）'}`);
  console.log(`  当前输入摘要: ${snapshot.sha256}`);
  console.log(`  快照输入摘要: ${baseline?.sha256 || '（缺失）'}`);
  if (snapshot.artifactGraphVersionLockSha256 !== undefined) {
    console.log(`  artifact-graph 版本锁摘要: ${snapshot.artifactGraphVersionLockSha256}`);
  }
  console.log('  变化文件:');
  if (gitStatus.changed.length) {
    for (const path of gitStatus.changed) console.log(`    - ${path}`);
  } else {
    console.log('    - （无）');
  }
  console.log('  版本源当前值:');
  if (versionSources.values.length) {
    for (const item of versionSources.values) {
      console.log(`    - ${item.token}=${item.renderedValue} (${item.source}#${item.pointer})`);
    }
  } else {
    console.log('    - （未配置）');
  }
  console.log('  建议 git diff:');
  for (const command of gitStatus.suggestions) console.log(`    ${command}`);
  if (!consistent) {
    throw new RenderError(`[render-public-site --status] ${repo.name}: 覆盖快照${baseline === null ? '缺失' : '落后'}`, 1);
  }
}

// --- 树摘要（基于 computeResourceClosure，排除 site-baseline.json 自身，防 hash 循环） ---
async function treeDigest(rootAbs, files) {
  const closure = await computeResourceClosure({
    root: rootAbs,
    resources: files.map((path) => ({ path, role: 'input' })),
  });
  return closure.digest;
}

async function listTargetFiles(rootAbs) {
  const out = [];
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const fp = join(d, e.name);
      if (e.isDirectory()) await walk(fp);
      else out.push(relative(rootAbs, fp));
    }
  }
  await walk(rootAbs);
  return out.filter((f) => f !== 'site-baseline.json').sort();
}

// 泄漏扫描统一入口：命中归为 RenderError(exit 1)，其余异常原样抛出。
function scanOrThrow(relPath, text, leakLiterals) {
  try {
    scanLeak(relPath, text, { literals: leakLiterals });
  } catch (err) {
    if (err instanceof LeakScanError) throw new RenderError(err.message, 1);
    throw err;
  }
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new TypeError(`${label} must be valid UTF-8`, { cause });
  }
}

function editorialMetadata(pagesDoc, tokens) {
  const text = (value, label) => replaceMarkdownTokens(value, tokens, label);
  return {
    site: {
      title: text(pagesDoc.site.title, 'site.title'),
      description: text(pagesDoc.site.description, 'site.description'),
      productKind: pagesDoc.site.productKind,
    },
    groups: pagesDoc.groups.map((group) => ({
      ...group,
      title: text(group.title, `group ${group.id} title`),
    })),
  };
}

async function markdownOutputs(root, repo, dirRel, pagesDoc, tokens) {
  if (repo.site.template !== 'editorial') {
    throw new TypeError(`unsupported template: ${repo.site.template}`);
  }
  const containedDir = await resolveContained(root, dirRel);
  const expected = new Set(pagesDoc.pages.map((page) => `${page.id}.md`));
  const actual = new Set((await readdir(containedDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name));
  const mismatches = [
    ...[...expected].filter((name) => !actual.has(name)).map((name) => `missing ${name}`),
    ...[...actual].filter((name) => !expected.has(name)).map((name) => `undeclared ${name}`),
  ].sort();
  if (mismatches.length) throw new TypeError(`Markdown source set does not match pages.json: ${mismatches.join(', ')}`);

  const images = new Set();
  const pages = [];
  for (const page of pagesDoc.pages) {
    const rel = join(dirRel, `${page.id}.md`);
    const source = decodeUtf8(await readFileContained(root, rel), `${page.id}.md`);
    const compiled = compileMarkdownV1(source, { pageId: page.id, tokens });
    compiled.images.forEach((path) => images.add(path));
    pages.push({
      ...page,
      title: replaceMarkdownTokens(page.title, tokens, `page ${page.id} title`),
      ...(page.navTitle === undefined ? {} : {
        navTitle: replaceMarkdownTokens(page.navTitle, tokens, `page ${page.id} navTitle`),
      }),
      blocks: compiled.blocks,
    });
  }

  const rendered = renderEditorialSite({ ...editorialMetadata(pagesDoc, tokens), pages });
  const outputs = rendered.pages.map((page) => {
    const text = `<!-- generated by skill-family-doc-render -->\n${page.text}`;
    return { path: page.path, text, bytes: Buffer.from(text, 'utf8') };
  });
  for (const asset of rendered.assets) {
    const bytes = await readFile(asset.source);
    outputs.push({ path: asset.path, text: decodeUtf8(bytes, asset.path), bytes });
  }
  for (const path of [...images].sort()) {
    const bytes = await readFileContained(root, join(dirRel, path));
    const text = decodeUtf8(bytes, path);
    assertSafeSvg(text, path);
    outputs.push({ path, text, bytes });
  }
  return outputs;
}

// --- 渲染单仓 ---
async function renderRepo(root, repo, release, leakLiterals, { check, assertGit, inputOnly = false }) {
  const site = repo.site;
  const dirRel = join(repo.source, site.dir);
  const pagesRel = join(dirRel, site.pages);
  const targetRel = join(repo.source, site.target);
  const sourceAbs = resolve(root, repo.source);
  const dirAbs = resolve(root, dirRel);
  const targetAbs = resolve(root, targetRel);
  const rootSourceRel = relative(root, sourceAbs);
  const sourceTargetRel = relative(sourceAbs, targetAbs);
  const sourceDirRel = relative(sourceAbs, dirAbs);
  const contained = (rel) => rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/');
  const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  if (!(rootSourceRel === '' || contained(rootSourceRel)) || !contained(sourceTargetRel) || !contained(sourceDirRel) || overlaps(sourceTargetRel, sourceDirRel)) {
    throw new RenderError(
      `[render-public-site] ${repo.name}: site.target 必须严格收容于 repo.source，且不得与 site.dir 相同或重叠 (source=${repo.source}, dir=${site.dir}, target=${site.target})`,
      2,
    );
  }
  if (!existsSync(resolve(root, pagesRel))) {
    throw new RenderError(`[render-public-site] ${repo.name}: pages.json 未找到: ${pagesRel}`, 2);
  }
  const pagesDoc = await readJsonContained(root, pagesRel, 'pages.json', repo.name);
  assertValid(pagesDoc, pagesSchema, `${repo.name} pages.json`);
  const ordered = [...pagesDoc.pages].sort((a, b) => a.order - b.order);
  const pagerPages = ordered.filter((p) => p.inPager !== false);

  function navHtml(currentId) {
    const items = ordered
      .map((p) => `    <a href="${p.id}.html"${p.id === currentId ? ' class="active" aria-current="page"' : ''}>${p.title}</a>`)
      .join('\n');
    return `<nav class="toc" aria-label="主要导航">\n${items}\n  </nav>`;
  }
  function pagerHtml(currentId) {
    const idx = pagerPages.findIndex((p) => p.id === currentId);
    if (idx < 0) return '';
    const prev = pagerPages[(idx - 1 + pagerPages.length) % pagerPages.length];
    const next = pagerPages[(idx + 1) % pagerPages.length];
    return `<nav class="pager" aria-label="教程翻页">\n    <a href="${prev.id}.html">← ${prev.title}</a>\n    <span class="spacer"></span>\n    <a href="${next.id}.html">${next.title} →</a>\n  </nav>`;
  }
  function footerHtml() {
    const owner = release.owner || 'your-org';
    return `<footer class="site">\n  <div>© ${owner} · <a href="https://www.apache.org/licenses/LICENSE-2.0" rel="noopener noreferrer">Apache-2.0</a></div>\n  <div class="generated">generated by skill-family-doc-render</div>\n</footer>`;
  }

  // 版本占位符：保留按 repo 名自动派生的兼容 token；显式 JSON 版本源最后覆盖静态 token。
  const version = await pkgVersion(root, repo.source, repo.name);
  const versionSources = await loadVersionSources(sourceAbs, repo);
  const tn = tokenName(repo.name);
  const tokens = {
    [`@${tn}_TAG@`]: (repo.tagPrefix || `${repo.name}-v`) + version,
    [`@${tn}_VERSION@`]: version,
    ...(site.tokens || {}),
    ...versionSources.tokens,
  };
  function replaceTokens(s) {
    let out = s;
    for (const [k, v] of Object.entries(tokens)) out = out.split(k).join(String(v));
    return out;
  }

  // --- 内存渲染全部产物（页面 + assets + .nojekyll）；任何失败发生在写盘之前 ---
  // outputs: { path: target 内相对路径, text: 扫描用文本, bytes: 落盘字节 }
  let outputs;
  if (site.format === 'markdown-v1') {
    try {
      outputs = await markdownOutputs(root, repo, dirRel, pagesDoc, tokens);
    } catch (cause) {
      throw configError(repo.name, `markdown-v1 输入错误: ${cause.message}`, cause);
    }
  } else {
    if (pagesDoc.groups !== undefined) {
      throw configError(repo.name, 'markdown-v1 页面清单必须显式配置 site.format 与 site.template');
    }
    outputs = [];
    for (const p of ordered) {
      let html = await readFileContained(root, join(dirRel, p.id + '.html'), { encoding: 'utf8' });
      html = html
        .replace(/<!--NAV-->/g, navHtml(p.id))
        .replace(/<!--PAGER-->/g, pagerHtml(p.id))
        .replace(/<!--FOOTER-->/g, footerHtml());
      html = replaceTokens(html);
      // 未替换的 @TOKEN@ 占位符残留 fail-fast（防占位符幻觉静默穿透进产物 / 基线 / 发布）
      const residual = html.match(/@[A-Z0-9_]+@/g);
      if (residual) {
        throw new RenderError(
          `[render-public-site] ${repo.name}: ${p.id}.html 残留未替换的占位符: ${[...new Set(residual)].join(', ')}`,
          2,
        );
      }
      const out = '<!-- generated by skill-family-doc-render -->\n' + html;
      outputs.push({ path: p.id + '.html', text: out, bytes: Buffer.from(out, 'utf8') });
    }
    // 旧 HTML 兼容模式继续复制项目自有资源。
    const assetSrc = resolve(root, dirRel, 'assets');
    if (existsSync(assetSrc)) {
      for (const f of (await readdir(assetSrc)).sort()) {
        if (['.html', '.css', '.js', '.svg'].includes(extname(f))) {
          const bytes = await readFileContained(root, join(dirRel, 'assets', f));
          outputs.push({ path: 'assets/' + f, text: bytes.toString('utf8'), bytes });
        }
      }
    }
  }
  // .nojekyll：禁止 GitHub Pages 跑 Jekyll
  outputs.push({ path: '.nojekyll', text: '', bytes: Buffer.alloc(0) });

  // 写盘前统一泄漏扫描：页面与 assets 同一规则（对解码后内容）
  for (const o of outputs) scanOrThrow(`${repo.name}/${o.path}`, o.text, leakLiterals);
  if (inputOnly) return;

  // 逐文件 sha256（harness digestBytes），--check 与基线逐文件比对用
  const digests = {};
  for (const o of outputs) digests[o.path] = digestBytes(o.bytes);
  const files = Object.keys(digests).sort();

  if (check) {
    if (!existsSync(targetAbs)) {
      throw new RenderError(
        `[render-public-site --check] ${repo.name}: 目标 ${targetRel} 不存在，请先运行渲染`,
        1,
      );
    }
    const baselineRel = join(targetRel, 'site-baseline.json');
    if (!existsSync(resolve(root, baselineRel))) {
      throw new RenderError(
        `[render-public-site --check] ${repo.name}: 未找到已提交基线 site-baseline.json（请先渲染并提交）`,
        1,
      );
    }
    let base;
    try {
      base = JSON.parse(await readFileContained(root, baselineRel, { encoding: 'utf8' }));
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new RenderError(
          `[render-public-site --check] ${repo.name}: site-baseline.json JSON 解析失败（基线损坏，请重新渲染）: ${err.message}`,
          1,
        );
      }
      throw err;
    }
    assertValid(base, siteBaselineSchema, `${repo.name} site-baseline.json`);

    const drift = [];
    // 1) 内存渲染产物 vs 基线逐文件摘要：抓「源改未重渲」与「渲染器回归」
    for (const f of files) {
      if (!(f in base.digests)) drift.push(`基线缺少文件（源新增未重渲）: ${f}`);
      else if (base.digests[f] !== digests[f]) drift.push(`内容漂移（源已改未重渲或渲染器回归）: ${f}`);
    }
    for (const f of Object.keys(base.digests)) {
      if (!(f in digests)) drift.push(`基线仍有但源渲染已不产生: ${f}`);
    }
    // 2) 磁盘 target 实际文件清单 vs baseline.files：抓 docs/ 被手工增删文件
    const diskFiles = await listTargetFiles(targetAbs);
    const baseSet = new Set(base.files);
    const diskSet = new Set(diskFiles);
    for (const f of diskFiles) if (!baseSet.has(f)) drift.push(`target 多出未登记文件: ${f}`);
    for (const f of base.files) if (!diskSet.has(f)) drift.push(`target 缺少基线文件: ${f}`);
    // 3) 磁盘产物内容 vs 基线树摘要：抓产物被手工修改
    const diskHash = await treeDigest(targetAbs, diskFiles);
    if (diskHash !== base.sha256) drift.push('磁盘产物树摘要与基线不一致（产物被手工修改）');

    if (drift.length) {
      throw new RenderError(
        `[render-public-site --check] ${repo.name}: 漂移:\n  - ${drift.join('\n  - ')}`,
        1,
      );
    }
    console.log(`[render-public-site --check] ${repo.name}: 一致，无漂移`);
    return;
  }

  // assert-git 必须在任何 target 变更前完成，避免门禁失败留下部分替换结果。
  if (assertGit) {
    const expected = files.map((f) => `${targetRel}/${f}`);
    let missing = 0;
    for (const f of expected) {
      try {
        execFileSync('git', ['ls-files', '--error-unmatch', f], { cwd: root, stdio: 'pipe' });
      } catch {
        console.error(`[assert-git] ${repo.name}: 未跟踪（需 git add 并提交）: ${f}`);
        missing++;
      }
    }
    if (missing) throw new RenderError(`[assert-git] ${repo.name}: ${missing} 个文件未进 Git 快照，站点无法进入发布`, 1);
    console.log(`[assert-git] ${repo.name}: 全部站点文件已在 Git 快照中`);
  }

  // --- 写盘事务化：在目标目录的 canonical parent 内创建 sibling staging，
  // 写入和发布均使用 Foundation 公共目录发布 API。 ---
  await resolveContained(root, targetRel);
  const targetParent = await realpath(dirname(targetAbs));
  const targetSegment = basename(targetAbs);
  const staging = await mkdtemp(join(targetParent, '.sf-doc-render-'));
  let treeHash;
  let publicationAttempted = false;
  try {
    for (const o of outputs) await writeFileAtomic(staging, o.path, o.bytes);
    treeHash = await treeDigest(staging, files);
    await writeFileAtomic(staging, 'site-baseline.json', JSON.stringify({ sha256: treeHash, files, digests }, null, 2));
    const targetExists = existsSync(targetAbs);
    if (!targetExists) {
      const manifest = await createFixedSetPublicationManifest({ sourceRoot: staging, targetParent, targetSegment });
      publicationAttempted = true;
      const receipt = await publishFixedSet({ sourceRoot: staging, targetParent, targetSegment, manifest });
      if (receipt.status !== 'succeeded') {
        if (receipt.commitState === 'not-committed') await rm(staging, { recursive: true, force: true });
        throw new Error(`[render-public-site] ${repo.name}: 目录发布失败 (${receipt.status}): ${receipt.error?.message ?? 'unknown'}`);
      }
    } else {
      publicationAttempted = true;
      const result = await replaceFixedSetAtomic({ sourceRoot: staging, targetParent, targetSegment });
      try {
        await rm(result.displacedTargetPath, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new Error(`[render-public-site] ${repo.name}: 发布已成功、旧目标清理失败: ${result.displacedTargetPath}; ${cleanupError.message}`, { cause: cleanupError });
      }
    }
    console.log(`[render-public-site] ${repo.name}: 已渲染 ${ordered.length} 页 + assets 到 ${targetRel}`);
    console.log(`[render-public-site] ${repo.name}: tree-sha256=${treeHash.slice(0, 16)}…`);
  } catch (err) {
    const preCommit = err?.details?.phase === 'pre-commit' && err?.details?.publicationState === 'not-published' && err?.details?.commitState === 'not-committed';
    if (!publicationAttempted || preCommit) await rm(staging, { recursive: true, force: true });
    throw err;
  }

}

function projectRecoveryPrompt(repoName) {
  return `请使用 skill-family-docs-render-site 处理仓库 ${repoName} 的知识站检查失败。先读取 public-release.json 和 skill-family-doc-render --check-project --repo ${repoName} 的实际输出，再判断需要内容刷新、纯渲染还是修正配置。不提前刷新覆盖快照，不手改生成产物。`;
}

function projectCheckError(repoName, cause, fallbackExitCode = 1) {
  const exitCode = Number.isInteger(cause?.exitCode) ? cause.exitCode : fallbackExitCode;
  return new RenderError(
    `[render-public-site --check-project] ${repoName}: public-release.json 检查失败\n`
    + `实际原因: ${cause.message}\n`
    + `恢复提示: ${projectRecoveryPrompt(repoName)}`,
    exitCode,
    cause,
  );
}

async function checkProject(root, repo, release, leakLiterals) {
  try {
    await renderRepo(root, repo, release, leakLiterals, { check: false, assertGit: false, inputOnly: true });
    console.log(`[render-public-site --check-project] ${repo.name}: 输入、公开安全与正文机械合同通过`);
    await reportCoverageStatus(root, repo);
    await renderRepo(root, repo, release, leakLiterals, { check: true, assertGit: false });
    const sourceRoot = await repoSourceRoot(root, repo);
    const targetDir = await containedOrConfig(sourceRoot, repo.site.target, repo.name, 'site.target');
    const pagesDoc = await readJsonContained(sourceRoot, join(repo.site.dir, repo.site.pages), 'pages.json', repo.name);
    await checkRenderedLinks({ targetRoot: targetDir, pageIds: pagesDoc.pages.map((page) => page.id) });
    console.log(`[render-public-site --check-project] ${repo.name}: 内部链接与资源通过`);
    console.log(`[render-public-site --check-project] ${repo.name}: public-release.json 只读项目检查通过`);
  } catch (cause) {
    throw projectCheckError(repo.name, cause);
  }
}

// === 主流程 ===
// 闭集参数解析：允许参数只有 --check / --assert-git / --status /
// --refresh-coverage / --check-project / --repo <name> / --help / -h。
// 未知选项、游离位置参数、重复取值参数、--repo 缺值或值本身是另一个选项，
// 均以 RenderError（exit 2）失败，错误信息指出具体参数。不引入 CLI 框架。
// --help / -h 由 main() 统一呈现：闭集解析先于配置读取与写盘，打印 USAGE_TEXT 后退出 0。
const USAGE_TEXT = `skill-family-doc-render — config-driven GitHub Pages knowledge-site renderer

Usage:
  skill-family-doc-render                render every repo with a site field (writes)
  skill-family-doc-render --check        read-only drift check against site-baseline.json
  skill-family-doc-render --repo <name>  render / check a single repo by name
  skill-family-doc-render --assert-git   also assert rendered files are git-tracked
  skill-family-doc-render --status --repo <name>
                                        read-only coverage status and Git changes
  skill-family-doc-render --refresh-coverage --repo <name>
                                        refresh only site-coverage-lock.json
  skill-family-doc-render --check-project --repo <name>
                                        read-only input, coverage, render and link checks

Reads public-release.json from the current working directory.`;

function parseArgs(argv) {
  const flags = {
    check: false,
    assertGit: false,
    status: false,
    refreshCoverage: false,
    checkProject: false,
    repoArg: null,
    help: false,
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--check') {
      flags.check = true;
    } else if (arg === '--assert-git') {
      flags.assertGit = true;
    } else if (arg === '--status') {
      flags.status = true;
    } else if (arg === '--refresh-coverage') {
      flags.refreshCoverage = true;
    } else if (arg === '--check-project') {
      flags.checkProject = true;
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--repo') {
      if (flags.repoArg !== null) {
        throw new RenderError('[render-public-site] 参数错误: --repo 重复出现，取值语义不明确', 2);
      }
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('-')) {
        throw new RenderError('[render-public-site] --repo 后必须跟一个有效的 repo 名（不能缺省，且值不能是另一个选项）', 2);
      }
      flags.repoArg = value;
      i += 1; // 消费取值
    } else if (arg.startsWith('-')) {
      throw new RenderError(`[render-public-site] 参数错误: 未知选项 ${arg}`, 2);
    } else {
      throw new RenderError(`[render-public-site] 参数错误: 未知位置参数 ${arg}`, 2);
    }
    i += 1;
  }
  if (flags.status && flags.refreshCoverage) {
    throw new RenderError('[render-public-site] 参数错误: --status 与 --refresh-coverage 不能同时使用', 2);
  }
  if ((flags.status || flags.refreshCoverage) && (flags.check || flags.assertGit)) {
    throw new RenderError('[render-public-site] 参数错误: 覆盖命令不能与 --check 或 --assert-git 组合', 2);
  }
  if ((flags.status || flags.refreshCoverage) && flags.repoArg === null) {
    throw new RenderError('[render-public-site] 参数错误: --status 与 --refresh-coverage 必须配合 --repo <name>', 2);
  }
  if (flags.checkProject && (flags.check || flags.assertGit || flags.status || flags.refreshCoverage || flags.help)) {
    throw projectCheckError(
      flags.repoArg ?? '<missing>',
      new RenderError('参数错误: --check-project 不能与其他检查、覆盖、Git 或帮助模式组合', 2),
      2,
    );
  }
  if (flags.checkProject && flags.repoArg === null) {
    throw projectCheckError(
      '<missing>',
      new RenderError('参数错误: --check-project 必须配合 --repo <name>', 2),
      2,
    );
  }
  return flags;
}

// argv: CLI 参数（不含 node/script 名）；cwd: 工作区根（public-release.json 所在目录）。
// 返回退出码 0；可预期失败抛 RenderError（携带 exitCode），其余异常原样抛出。
// 多仓遍历失败隔离：每 repo try/catch 收集结果，全部遍历完后汇总，任一失败整体非零退出；
// 单个 repo 内部（含泄漏扫描命中）保持 fail-fast。
export async function main(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  // 闭集解析在读取任何配置或写盘之前完成；参数失败时目标树一个字节都不动。
  const { check, assertGit, status, refreshCoverage, checkProject: projectCheck, repoArg, help } = parseArgs(argv);
  if (help) {
    console.log(USAGE_TEXT);
    return 0;
  }

  const root = resolve(cwd);

  // --- 读取发布配置 ---
  const releasePath = resolve(root, 'public-release.json');
  if (!existsSync(releasePath)) {
    const cause = new RenderError('[render-public-site] 未找到 public-release.json', 2);
    throw projectCheck ? projectCheckError(repoArg, cause, 2) : cause;
  }
  let release;
  try {
    release = await readJsonContained(root, 'public-release.json', 'public-release.json', '(workspace)');
    assertValid(release, publicReleaseSchema, 'public-release.json');
  } catch (cause) {
    if (projectCheck) throw projectCheckError(repoArg, cause, 2);
    throw cause;
  }

  // 泄漏扫描追加字面量（来自配置；路径类用 forbiddenPublicPaths，任意私有词用 privateLiterals）
  const leakLiterals = [
    ...(release.forbiddenPublicPaths || []),
    ...(release.privateLiterals || []),
  ];

  // 选 repo：所有带 site 者；--repo 指定则只取该 name
  let selected = (release.repos || []).filter((r) => r.site);
  if (repoArg) {
    const hit = selected.find((r) => r.name === repoArg);
    if (!hit) {
      const cause = new RenderError(`[render-public-site] 未找到带 site 的 repo: ${repoArg}`, 2);
      throw projectCheck ? projectCheckError(repoArg, cause, 2) : cause;
    }
    selected = [hit];
  }
  if (!selected.length) {
    throw new RenderError('[render-public-site] public-release.json 中没有带 site 字段的 repo', 2);
  }

  const results = [];
  for (const repo of selected) {
    try {
      if (status) await reportCoverageStatus(root, repo);
      else if (refreshCoverage) await refreshCoverageLock(root, repo);
      else if (projectCheck) await checkProject(root, repo, release, leakLiterals);
      else await renderRepo(root, repo, release, leakLiterals, { check, assertGit });
      results.push({ name: repo.name, ok: true });
    } catch (err) {
      results.push({
        name: repo.name,
        ok: false,
        exitCode: Number.isInteger(err?.exitCode) ? err.exitCode : 1,
        message: err.message,
        cause: err,
      });
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    // 汇总报告哪些成功哪些失败；退出码取失败中最严重一类（配置类 2 优先于漂移/泄漏类 1）
    const exitCode = failed.some((f) => f.exitCode === 2) ? 2 : 1;
    const lines = results.map((r) => (r.ok ? `  ✓ ${r.name}: 成功` : `  ✗ ${r.name}: ${r.message}`));
    const aggregate = new RenderError(
      `[render-public-site] ${failed.length}/${results.length} 个 repo 失败:\n${lines.join('\n')}`,
      exitCode,
    );
    if (failed.length === 1 && failed[0].cause?.code) {
      aggregate.code = failed[0].cause.code;
      aggregate.details = failed[0].cause.details;
    }
    throw aggregate;
  }
  return 0;
}

// CLI 自执行（直接 node scripts/render-public-site.mjs 时；bin 入口亦走 main）
const invokedAsCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err.message);
      process.exitCode = err instanceof RenderError ? err.exitCode : 1;
    });
}
