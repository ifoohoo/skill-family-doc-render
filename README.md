# skill-family-doc-render

面向技能族（Skill Family）与命令行工具的配置驱动静态文档站生成器与只读质量检查 CLI（支持单工作区多仓库）。

在线文档（GitHub Pages）：<https://ifoohoo.github.io/skill-family-doc-render-site/>

工具从当前工作目录读取 `public-release.json`，遍历声明了 `site` 字段的仓库，将 `site.dir` 下的 Markdown 源文件编译为现代三栏响应式静态网站并输出到 `site.target` 目录。新站点采用 `format: "markdown-v2"` 与内置 `template: "modern"` 主题；存量配置声明的 `markdown-v1` 与 `editorial` 会自动平滑映射到现代编译内核与 `modern` 设计系统，未声明 `format` 的旧项目继续走完整 HTML 注入兼容路径。

写盘前在内存中完成版本占位符替换、静态语法着色、SVG 安全检查、解码后私密内容泄漏扫描、`.nojekyll` 生成与可选 `--assert-git` 索引校验；全部通过后才在目标同级暂存区写出 `site-baseline.json`，并通过 Foundation 固定集合接口原子替换目标目录。

## 核心能力

- **现代三栏响应式主题（`modern`）**：吸顶毛玻璃顶栏、版本胶囊、`⌘K / Ctrl+K` 全文搜索、浅/深色单图标切换（无 JS 自动跟随系统配色）、256px 分组侧栏、780px 阅读版心、220px 实时滚动高亮大纲（`>=1920px` 宽屏外框放宽至 `1560px` 并保持 `780px` 正文阅读行宽）、极简悬停浮现 `#` 标题锚点与移动端抽屉目录，在 320px–2560px 全视口下零横向溢出。
- **6 大 AI 技能族原生组件**：
  1. `::: tabs sync="host"` + `::: tab <宿主名>`：全站偏好记忆的多宿主切换标签（支持 Claude Code / Codex / Kimi / WorkBuddy / Antigravity，无 JS 降级自动展开）。
  2. ` ```prompt ` / `::: prompt` 与语法高亮代码块：AI 对话提示词卡片（左侧靛蓝紫竖条、柔和靛蓝染色底板与鲜明顶栏胶囊徽章）与终端/JSON/YAML/JS 代码块视觉彻底分离，内置零外部依赖静态语法着色与一键复制反馈。
  3. `::: steps`：带数字圆环与竖向引导线的序号步骤流。
  4. `::: cards` + `::: card`：响应式能力导览卡片网格。
  5. `::: file-tree`：带文件夹/文件图标与右侧对齐注释的目录结构可视化树。
  6. `::: tip / info / warning / danger` 四色提示框与 `::: diagram src="assets/..."`（安全内嵌 SVG 或带 `sandbox="allow-scripts"` 的 Archify 交互图，附放大查看与新窗口打开）。
- **确定性 `?v=<sha8>` 内容指纹防旧缓存**：输出目录保留干净文件名（`assets/theme.css`、`assets/site.js`、`assets/search-index.json`、`assets/mark.svg`），HTML 引用自动附加真实字节 SHA-256 前 8 位摘要（`?v=<sha8>`）。仅改文档正文时不改变 `theme.css?v=` 与 `site.js?v=`，只更新 `data-search-index?v=`；一旦升级样式或脚本，所有页面的 `?v=` 立即穿透浏览器与 CDN 缓存。
- **弹性信息架构（`pages.json`）**：只需声明 `site: { title, tagline?, version? }`、`groups: [{ id, title }]` 与 `pages: [{ id, title, navTitle?, summary?, group? }]`，自然按数组顺序派生上下篇翻页；同时向后兼容旧 `pages.json` 的 `role` / `kind` / `order` / `inPager` 字段。

## 安装与运行前提

运行环境要求 Node.js `>=22.22.2 <23`。在官方 npm registry 确认精确版本可用后安装：

```sh
npm install --save-exact skill-family-doc-render@0.7.0
```

运行时精确锁定 `marked@18.0.11`、`skill-family-contracts@0.39.0` 与 `skill-family-harness-node@0.39.0`。

## 命令行用法

除 `--read-proof` 外，其余命令均在包含 `public-release.json` 的工作区根目录执行：

```sh
# 查看完整命令行参数与退出码说明
npx skill-family-doc-render@0.7.0 --help

# 渲染全部声明了 site 的仓库（写盘）
npx skill-family-doc-render@0.7.0

# 只读比对内存渲染结果与磁盘 site-baseline.json，不写盘
npx skill-family-doc-render@0.7.0 --check

# 仅针对指定名称的仓库渲染或检查
npx skill-family-doc-render@0.7.0 --repo <name>

# 先断言渲染文件均已被 Git 索引跟踪，通过后再渲染（加 --check 则全程只读）
npx skill-family-doc-render@0.7.0 --assert-git
npx skill-family-doc-render@0.7.0 --check --assert-git

# 查询或刷新产品输入覆盖快照（site-coverage-lock.json）
npx skill-family-doc-render@0.7.0 --status --repo <name>
npx skill-family-doc-render@0.7.0 --refresh-coverage --repo <name>

# 多视口/宽元素版面溢出静态抽检（默认评估 320,390,768,1280 像素视口）
npx skill-family-doc-render@0.7.0 --check-layout --repo <name>
npx skill-family-doc-render@0.7.0 --check-layout --repo <name> --viewports 320,390,768,1280

# 技能指令与说明文档过时限制词及失效引用静态检查
npx skill-family-doc-render@0.7.0 --check-stale-limits --repo <name>

# 发布前只读项目综合检查（可选排他写出共同证明 JSON）
npx skill-family-doc-render@0.7.0 --check-project --repo <name>
npx skill-family-doc-render@0.7.0 --check-project --repo <name> --conclusion-output /absolute/path/conclusion.json

# 在任意工作目录只读读取并解释本族共同证明（不重扫目标项目）
npx skill-family-doc-render@0.7.0 --read-proof --proof-root /absolute/proof-root --proof relative/conclusion.json
```

### 退出码约定

- `0`：渲染或只读检查全部通过；
- `1`：检出内容或状态问题（基线漂移、覆盖快照缺失或落后、私有字面量泄漏、未跟踪渲染文件、死链、版面溢出或过时限制词）；
- `2`：配置、输入或参数错误（缺失或非法的 `public-release.json` / `pages.json`、未替换 `@TOKEN@`、非法 Markdown/SVG、非法 CLI 参数组合或 Git 查询失败）。

### 故障诊断

- 退出码为 `1` 时：根据终端列出的具体检查阶段与文件路径回到源 Markdown 或 `pages.json` 修正，再重新渲染或执行 `--refresh-coverage` 更新覆盖锁；不要直接手动修改 `site.target` 中的生成 HTML，失败期间既有正式产物与基线会原样保留。
- 退出码为 `2` 时：核对 `public-release.json` 字段是否符合公开 Schema、`@TOKEN@` 是否已在 `versionSources` 或 `tokens` 中声明，以及独立公开文档仓是否以 `-site` 结尾且公开 README 已包含完整的 `https://` 在线文档地址。

## 配置文件：`public-release.json` 与 `pages.json`

```json
{
  "owner": "your-org",
  "defaultBranch": "main",
  "license": "Apache-2.0",
  "repos": [
    {
      "name": "my-project",
      "source": "packages/my-project",
      "tagPrefix": "my-project-v",
      "site": {
        "dir": "docs/public/site",
        "target": "docs/public/rendered",
        "pages": "pages.json",
        "format": "markdown-v2",
        "template": "modern",
        "publicSiteRepo": "your-org/my-project-site",
        "pagesUrl": "https://your-org.github.io/my-project-site/",
        "coverage": {
          "lock": "site-coverage-lock.json",
          "inputs": ["package.json", "src/**", "docs/public/site/**"]
        },
        "versionSources": {
          "@COMPONENT_VERSION@": {
            "source": "package.json",
            "pointer": "/version"
          }
        }
      }
    }
  ],
  "forbiddenPublicPaths": ["public-release.json"],
  "privateLiterals": []
}
```

## Foundation 基础设施复用

- `skill-family-harness-node`：路径收容读取、确定性摘要、`writeFileAtomic` 原子写、固定集合原子发布与排他证明写出。
- `skill-family-contracts`：JSON Schema 2020-12 严格校验与 `professional-conclusion` 公共证明契约。

## 许可证

Apache-2.0

<!-- release-skill:capability:safe-first-command -->
> **安全起点：** 在官方 npm registry 确认版本可用后，可在拥有 `public-release.json` 的目录运行 `npx skill-family-doc-render@0.7.0 --check-project --repo <name>`。该命令全程只读：在内存中校验渲染并与磁盘 `site-baseline.json` 比对，不改写目标目录、不发起网络请求、不读取凭据，且 Git 状态查询统一禁用 optional locks 以保持 `.git/index` 字节不变。

<!-- release-skill:capability:external-write-boundary -->
> **外部写入边界：** 默认渲染仅在目标目录的规范父目录下创建受控暂存目录并原子替换 `site.target`；`--refresh-coverage` 仅原子更新声明的覆盖锁文件；`--check`、`--status`、`--check-layout`、`--check-stale-limits`、`--read-proof` 与不带 `--conclusion-output` 的 `--check-project` 均不写入任何文件；带 `--conclusion-output` 时仅排他创建该证明文件且绝不覆盖已有文件。CLI 不执行任何 Git 写操作或网络写入，写盘前泄漏扫描命中私有字面量时立即阻断。
