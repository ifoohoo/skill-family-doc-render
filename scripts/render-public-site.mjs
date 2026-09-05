// SPDX-License-Identifier: Apache-2.0
// 通用 GitHub Pages 知识站渲染器（配置驱动，多仓库）。
// 遍历 public-release.json 中所有带 site 字段的 repo，渲染各自 docs/public/site/ 源到 docs/。
// 注入 nav / pager / footer、替换版本占位符、拷贝 assets、写 .nojekyll 与 tree 基线。
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
// 配置、pages.json 与基线文件先经 skill-family-contracts validateDocument
// （JSON Schema 2020-12，strict 策略）校验，校验失败 fail-fast。
//
// 错误分类（退出码语义）：
//   exit 1 — 漂移类：--check 检出漂移、泄漏扫描命中、--assert-git 缺失、
//            基线缺失 / 基线 JSON 损坏；
//   exit 2 — 配置类：public-release.json / pages.json 缺失、非法或 JSON 解析失败、
//            package.json JSON 解析失败、@TOKEN@ 占位符残留、--repo 参数无效；
//   其余意外异常（HarnessError 等）原样抛出，CLI 归为 exit 1。
//   可预期失败统一封装为 RenderError 携带 exitCode。
import { existsSync, readFileSync } from 'node:fs';
import { readdir, rm, mkdtemp, realpath } from 'node:fs/promises';
import { resolve, relative, extname, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  resolveContained,
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

const __dirname = dirname(fileURLToPath(import.meta.url));

// 包内 schema（渲染器自身资源，不属于工作区文件，直接读取）
const publicReleaseSchema = JSON.parse(
  readFileSync(join(__dirname, '..', 'schemas', 'public-release.schema.json'), 'utf8'),
);
const siteBaselineSchema = JSON.parse(
  readFileSync(join(__dirname, '..', 'schemas', 'site-baseline.schema.json'), 'utf8'),
);
const pagesSchema = JSON.parse(
  readFileSync(join(__dirname, '..', 'schemas', 'pages.schema.json'), 'utf8'),
);

// 可预期失败（配置缺失、校验失败、check 漂移、泄漏命中等）以此类型抛出，携带退出码。
export class RenderError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
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

// --- 渲染单仓 ---
async function renderRepo(root, repo, release, leakLiterals, { check, assertGit }) {
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
      .map((p) => `    <a href="${p.id}.html"${p.id === currentId ? ' class="active"' : ''}>${p.title}</a>`)
      .join('\n');
    return `<nav class="toc">\n${items}\n  </nav>`;
  }
  function pagerHtml(currentId) {
    const idx = pagerPages.findIndex((p) => p.id === currentId);
    if (idx < 0) return '<nav class="pager"></nav>';
    const prev = pagerPages[(idx - 1 + pagerPages.length) % pagerPages.length];
    const next = pagerPages[(idx + 1) % pagerPages.length];
    return `<nav class="pager">\n    <a href="${prev.id}.html">← ${prev.title}</a>\n    <span class="spacer"></span>\n    <a href="${next.id}.html">${next.title} →</a>\n  </nav>`;
  }
  function footerHtml() {
    const owner = release.owner || 'your-org';
    return `<footer class="site">\n  <div>© ${owner} · <a href="https://www.apache.org/licenses/LICENSE-2.0" rel="noopener noreferrer">Apache-2.0</a></div>\n  <div class="generated">generated by skill-family-doc-render</div>\n</footer>`;
  }

  // 版本占位符：按 repo 名自动派生（@{NAME}_TAG@ / @{NAME}_VERSION@）+ site.tokens 静态补充
  const version = await pkgVersion(root, repo.source, repo.name);
  const tn = tokenName(repo.name);
  const tokens = {
    [`@${tn}_TAG@`]: (repo.tagPrefix || `${repo.name}-v`) + version,
    [`@${tn}_VERSION@`]: version,
    ...(site.tokens || {}),
  };
  function replaceTokens(s) {
    let out = s;
    for (const [k, v] of Object.entries(tokens)) out = out.split(k).join(String(v));
    return out;
  }

  // --- 内存渲染全部产物（页面 + assets + .nojekyll）；任何失败发生在写盘之前 ---
  // outputs: { path: target 内相对路径, text: 扫描用文本, bytes: 落盘字节 }
  const outputs = [];
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
  // assets（allowlist：html/css/js/svg，不含 png；配图全部自绘 SVG）
  const assetSrc = resolve(root, dirRel, 'assets');
  if (existsSync(assetSrc)) {
    for (const f of (await readdir(assetSrc)).sort()) {
      if (['.html', '.css', '.js', '.svg'].includes(extname(f))) {
        const bytes = await readFileContained(root, join(dirRel, 'assets', f));
        outputs.push({ path: 'assets/' + f, text: bytes.toString('utf8'), bytes });
      }
    }
  }
  // .nojekyll：禁止 GitHub Pages 跑 Jekyll
  outputs.push({ path: '.nojekyll', text: '', bytes: Buffer.alloc(0) });

  // 写盘前统一泄漏扫描：页面与 assets 同一规则（对解码后内容）
  for (const o of outputs) scanOrThrow(`${repo.name}/${o.path}`, o.text, leakLiterals);

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

// === 主流程 ===
// 闭集参数解析：允许参数只有 --check / --assert-git / --repo <name> / --help / -h。
// 未知选项、游离位置参数、重复取值参数、--repo 缺值或值本身是另一个选项，
// 均以 RenderError（exit 2）失败，错误信息指出具体参数。不引入 CLI 框架。
// --help / -h 由 main() 统一呈现：闭集解析先于配置读取与写盘，打印 USAGE_TEXT 后退出 0。
const USAGE_TEXT = `skill-family-doc-render — config-driven GitHub Pages knowledge-site renderer

Usage:
  skill-family-doc-render                render every repo with a site field (writes)
  skill-family-doc-render --check        read-only drift check against site-baseline.json
  skill-family-doc-render --repo <name>  render / check a single repo by name
  skill-family-doc-render --assert-git   also assert rendered files are git-tracked

Reads public-release.json from the current working directory.`;

function parseArgs(argv) {
  const flags = { check: false, assertGit: false, repoArg: null, help: false };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--check') {
      flags.check = true;
    } else if (arg === '--assert-git') {
      flags.assertGit = true;
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
  return flags;
}

// argv: CLI 参数（不含 node/script 名）；cwd: 工作区根（public-release.json 所在目录）。
// 返回退出码 0；可预期失败抛 RenderError（携带 exitCode），其余异常原样抛出。
// 多仓遍历失败隔离：每 repo try/catch 收集结果，全部遍历完后汇总，任一失败整体非零退出；
// 单个 repo 内部（含泄漏扫描命中）保持 fail-fast。
export async function main(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  // 闭集解析在读取任何配置或写盘之前完成；参数失败时目标树一个字节都不动。
  const { check, assertGit, repoArg, help } = parseArgs(argv);
  if (help) {
    console.log(USAGE_TEXT);
    return 0;
  }

  const root = resolve(cwd);

  // --- 读取发布配置 ---
  const releasePath = resolve(root, 'public-release.json');
  if (!existsSync(releasePath)) {
    throw new RenderError('[render-public-site] 未找到 public-release.json', 2);
  }
  const release = await readJsonContained(root, 'public-release.json', 'public-release.json', '(workspace)');
  assertValid(release, publicReleaseSchema, 'public-release.json');

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
      throw new RenderError(`[render-public-site] 未找到带 site 的 repo: ${repoArg}`, 2);
    }
    selected = [hit];
  }
  if (!selected.length) {
    throw new RenderError('[render-public-site] public-release.json 中没有带 site 字段的 repo', 2);
  }

  const results = [];
  for (const repo of selected) {
    try {
      await renderRepo(root, repo, release, leakLiterals, { check, assertGit });
      results.push({ name: repo.name, ok: true });
    } catch (err) {
      results.push({
        name: repo.name,
        ok: false,
        exitCode: err instanceof RenderError ? err.exitCode : 1,
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
