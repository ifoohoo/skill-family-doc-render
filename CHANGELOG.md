# 变更日志

## 0.3.0 - 2026-09-07

### 新增

- 增加 `site.coverage` 和最小 `site-coverage-lock.json`，记录已审阅产品输入的文件摘要、
  聚合摘要，以及启用 artifact-graph 时的版本锁摘要。
- 增加只读的 `--status --repo <name>` 和只更新覆盖快照的
  `--refresh-coverage --repo <name>`。状态命令会报告覆盖提交、当前摘要、变化文件、
  权威版本值和建议执行的 Git diff 命令。
- 状态命令从 `repo.source` 发现所属 Git 仓库。目标位于外层工作区中的独立内层仓库时，
  覆盖提交、变化路径和 diff 建议只使用内层仓库历史。
- 增加 `site.versionSources`。渲染器从收容于 `repo.source` 的 JSON 文件和 JSON Pointer
  读取版本值，版本源文件自动加入覆盖输入。

### 安全与兼容

- 覆盖输入拒绝绝对路径、越界路径、空匹配和符号链接逃逸；覆盖锁始终排除自身，
  避免形成摘要循环。
- 保留现有静态 token 和按仓库名派生版本 token 的兼容行为；同名
  `site.versionSources` 取值优先。

## 0.2.1 - 2026-09-06

### 变更

- 生成的主导航带有可访问名称，并用 `aria-current="page"` 标出当前页。
- 教程翻页导航带有可访问名称；不参加翻页链的页面不再生成空导航元素。

## 0.2.0 - 2026-09-05

发布坐标：tag `skill-family-doc-render-v0.2.0`。

### 不兼容变更

- `site-baseline.json` 基线格式升级：新增必填字段 `digests`（渲染产物逐文件
  sha256）。`--check` 由「磁盘 docs/ 与基线比对」改为三重比对：内存渲染产物
  逐文件摘要对 `digests`、磁盘实际文件清单对 `files` 集合、磁盘树摘要对
  `sha256`。0.1.x 旧格式基线（无 `digests`）会被新 schema 拒绝（exit 2）；
  升级后必须重渲一次（`npx skill-family-doc-render@0.2.0`）更新基线。
- 退出码语义统一：exit 1 归漂移/泄漏类（`--check` 漂移、泄漏扫描命中、
  `--assert-git` 缺文件、基线缺失/损坏）；exit 2 归配置类（配置缺失或非法、
  JSON 解析失败、`@TOKEN@` 占位符残留、`--repo` 误用）。0.1.x 中泄漏失败与
  配置失败同为 exit 1，且 JSON 解析失败会以裸异常漏出。
- `--repo` 后缺有效值现在直接报错 exit 2；0.1.1 会静默当作「渲染全部」。

### 新增

- `pages.json` 走 JSON Schema（`schemas/pages.schema.json`）：缺 `pages` 字段
  或非法 JSON 由裸 TypeError 变为 fail-fast exit 2。
- `--check` 能抓到「源改未重渲」与「渲染器回归」两类漂移（0.1.x 只能抓
  产物被手改）。

### 变更

- 泄漏扫描覆盖 assets（`.html`/`.css`/`.js`/`.svg`）写盘前扫描；多趟解码
  防绕过（HTML 实体双趟、JS 反转义、URL 百分号解码），字面量大小写不敏感。
  默认字面量与正则一字未动；扩展仍只经 `forbiddenPublicPaths` /
  `privateLiterals` 配置追加。
- 未替换的 `@TOKEN@` 占位符残留 fail-fast（exit 2），列出 token 与所在文件。
- 写盘前预检：在 target 的 canonical parent 内创建 sibling staging，全部产物经 Foundation
  `writeFileAtomic` 写入。渲染、扫描、基线计算和 `--assert-git` 预检全部成功后才发布：
  target 已存在时用 `replaceFixedSetAtomic` 单次交换，成功后旧 target 位于
  `displacedTargetPath`，仅清理该路径；target 不存在时先用
  `createFixedSetPublicationManifest` 生成清单，再用 `publishFixedSet` 发布。预检或未提交
  失败时清理 staging，既有 target 保持不变；交换成功后的旧 target 清理失败不回滚已完成的发布。
- 多仓遍历失败隔离：逐仓收集结果，单仓失败不中断其他仓，末尾汇总并非零退出。
- `package.json` 缺失或缺 `version` 时输出醒目 WARNING 并回退 0.0.0
  （0.1.x 静默回退）；`package.json` 非法 JSON 为 fail-fast exit 2。
- `--assert-git` 在写盘前检查，期望清单从实际渲染产物派生，不再写死文件名；改用
  `execFileSync` 数组参数，消除 shell 注入面。
- Foundation 依赖统一精确锁定到 0.18.0：`skill-family-harness-node`、
  `skill-family-contracts` 与工作区使用的 `skill-family-engineering-kit` 均须从官方
  npm registry 安装并复核；不接受 `latest`、本地工作树、候选 tarball 或浮动版本。

## 0.1.1 - 2026-08-12

### 变更

- 自 0.1.0 以来：CLI 新增 `--help` 输出与 README 最小示例（`34c8bfd`）；
  引入 release-skill 发布配置与 README 合同标记（`d194801`）。
- 版本号随技能族 codebuddy 市场分发路径调整统一抬升，渲染器实现本身无行为变化。

发布坐标：tag `skill-family-doc-render-v0.1.1`（公开仓 commit `8b9c3d67`）。

## 0.1.0 - 2026-08-12

### 新增

- 初始版本：配置驱动的 GitHub Pages 知识站渲染器。读取工作区根
  `public-release.json`，遍历带 `site` 字段的 repo 渲染到各自 target；
  nav / pager / footer 注入、版本占位符替换、assets 拷贝、`.nojekyll` 与
  `site-baseline.json` 树基线、`--check` 漂移检测、`--repo` 单仓选择、
  写盘前内容级泄漏扫描。
