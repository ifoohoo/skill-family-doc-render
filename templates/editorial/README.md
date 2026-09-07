# Editorial 文档模板

本目录把已认可的阅读界面封装为渲染包内的纯模板函数。输入页面清单及语义内容块，返回静态 HTML 和固定资源位置；模板不读写项目文件。

这份说明面向渲染器集成者，假定读者了解 JavaScript 模块和当前项目的页面清单。该模板从 `skill-family-doc-render` 0.4.0 起由唯一 CLI 在显式 `markdown-v1` 模式中调用；使用前仍需从官方 npm registry 核对该精确版本是否可用。

## 最小调用

以下虚构项目从同一包的深层路径导入函数。它只有首页和一篇教程，可展示基础目录、首页入口与代码组件：

```js
import { renderEditorialSite } from 'skill-family-doc-render/templates/editorial/index.mjs';

const output = renderEditorialSite({
  site: {
    title: '青苔笔记',
    description: '虚构项目的操作说明',
    productKind: 'plugin',
  },
  groups: [{ id: 'start', title: '入门' }],
  pages: [
    {
      id: 'index', title: '从一项具体操作开始', navTitle: '开始使用',
      role: 'overview', kind: 'home', group: 'start', order: 0, inPager: false,
      blocks: [{ type: 'paragraph', content: ['准备项目后，整理第一份说明。'] }],
    },
    {
      id: 'setup', title: '准备项目并确认输入', navTitle: '准备项目',
      role: 'setup', kind: 'task', group: 'start', order: 1, inPager: true,
      blocks: [
        { type: 'paragraph', content: ['提供项目位置及已有说明。'] },
        { type: 'heading', level: 2, id: 'request', content: ['发起准备请求'] },
        { type: 'code', language: 'prompt', text: '检查当前项目，保留已有配置。' },
      ],
    },
  ],
});
```

调用不访问磁盘。示例返回两个页面；渲染器再执行资源收容、SVG 安全检查、泄漏扫描、基线计算和输出替换。

返回对象包含两个数组：

- `pages`：每项为 `{ path, text }`。页面路径固定为 `<id>.html`，文字是完整 HTML。
- `assets`：每项为 `{ path, source }`。`source` 是指向包内文件的 `URL` 对象；资源路径固定为 `assets/editorial/style.css`、`site.js` 和 `mark.svg`。

页面、资源和链接均使用相对路径，可部署在站点子路径。资源列表只列模板自带文件；正文图片由调用者根据内容源收集和检查。相同输入产生相同页面字节，数组按页面顺序输出，不使用日期、随机数、系统路径或网络结果。

## 页面清单

`site` 提供站点标题、简短描述和项目类型。`productKind` 支持 `plugin`、`library`；本函数按已确定的清单渲染，不根据类型另建导航。首次清单由 `skill-family-docs` 的本地接入与生成流程建立。

`groups` 按数组顺序定义分组，每组包含安全 ID 与显示标题。页面由 `group` 引用分组，在组内按 `order` 排序。页面字段及约束见下表。

| 字段 | 含义与约束 |
| --- | --- |
| `id` | 页面地址来源，全站唯一；允许字母、数字、下划线、短横线，首字符必须为字母或数字 |
| `title` | 唯一 H1、浏览器标题与搜索标题 |
| `navTitle` | 可选短导航标签；未提供时使用页面标题 |
| `role` | 读者任务，支持 overview、setup、first-success、maintenance、release、troubleshooting、upgrade、reference |
| `kind` | 固定版式，支持 home、task、reference、troubleshooting |
| `group` | 已声明的分组 ID |
| `order` | 全站唯一的安全整数，可以为负数 |
| `inPager` | 是否加入教程，只允许 task 页设为 true |
| `blocks` | 顺序排列的语义内容块，首项必须为非空段落 |

每站必须恰有一页 `home`，与 `overview` 职责成对出现。其余页面不强制凑齐职责；排错页和参考页使用相同阅读组件，但不生成教程操作入口。

首段只在页首显示一次，同时派生首页任务说明、页面描述与搜索文字，不另设摘要字段。首页从教程页中按顺序生成任务入口，主操作指向第一项；存在其他 `maintenance` 任务时显示次操作。教程前后页使用同一顺序，首尾不循环；只有一篇教程时不显示翻页组件。

## 语义内容块

`content` 等行内字段使用数组。最简单的数组只有字符串；需要强调或链接时，加入下面四种对象：

```js
[
  '操作完成后，查看',
  { type: 'link', href: 'setup.html#request', content: ['准备请求'] },
  { type: 'strong', content: ['必要条件'] },
  { type: 'em', content: ['可选说明'] },
  { type: 'code', text: 'project.config' },
]
```

强调节点允许继续包含行内内容；链接不能嵌套链接。模板转义所有文字，不把字符串解释为 HTML。

| 内容块 | 输入字段 | 输出 |
| --- | --- | --- |
| paragraph | `content` 行内数组 | 段落；首块用作导语 |
| heading | `level` 为 2–4，`id` 与 `content` | 稳定标题、章节链接及页内目录 |
| list | `ordered` 布尔值，`items` 为行内数组的数组 | 有序步骤或普通列表，不支持嵌套列表 |
| table | `headers` 为行内单元格数组，`rows` 为行数组 | 带列标题的表格，宽表在本地容器滚动 |
| code | `language` 语言标记，`text` 原文 | 代码块；prompt 标记显示提示词组件 |
| callout | `tone` 为 NOTE、TIP、WARNING，`content` | 说明、建议或注意提示框 |
| image | `src` 站内 SVG 路径，`alt` 非空替代说明 | 普通 img，不内联 SVG |

代码复制保留 `text` 的首尾空白与换行。模板不执行命令，也不做语法高亮。列表项和提示框仅支持行内内容；嵌套容器、页签、自定义布局和任意属性不在当前接口内。

标题 ID 与页面 ID 使用相同字符范围。同页标题不能重复，也不能与当前页面 ID 冲突。`editorial-` 前缀保留给页面外框及代码控件；输入使用此前缀时报告错误。标题更名应保留原 ID。

普通链接支持 `http`、`https` 和不含查询参数的 `mailto`。站内链接使用已声明的 `页面ID.html`、`页面ID.html#章节ID` 或 `#章节ID`，页面地址可加 `./`。

本站链接必须能在当前输入中找到目标。不接受上级目录、根相对地址、查询参数、协议相对地址或任意协议；外部网页不在本函数中联网验证。

图片路径限于 `assets/` 下的 `.svg` 文件，目录与文件名使用字母、数字、下划线、短横线；`assets/editorial/` 是模板资源保留目录。这里只校验引用形式，不读取或检查 SVG 字节。调用者仍须执行资源收容、主动内容检查和现有泄漏扫描。

无效清单、重复 ID、未知字段、非法链接及不支持的块会抛出 `TypeError`，不会返回部分产物。CLI 退出码和既有输出保留由后续唯一渲染入口处理。

## 浏览器增强与降级

不运行 JavaScript 时，正文、页面目录、章节链接及教程翻页都可用。手机目录采用原生 details；主题通过 CSS 跟随系统。无功能的按钮在初始 HTML 中隐藏，相关处理器安装后才显示。

脚本提供本地搜索、复制、外观选择、移动目录和当前章节高亮。搜索索引从完整公开语义内容派生，包含代码、表格和图片替代说明；结果按标题命中优先，再按页面与章节顺序排列。搜索只使用页面内嵌数据，不联网。

搜索支持方向键、回车、Escape 及中文输入法组合态保护。关闭模态窗口后恢复触发控件和阅读位置；正常页面跳转使用真实链接。外观偏好仅保存在浏览器本地，复制失败时提示手动复制，不虚报成功。

## Markdown 接线与验证

`markdown-v1` 使用精确依赖 `marked@18.0.11` 分词，再由本包的受限格式编译器生成上述内存对象。该对象是解析阶段到模板阶段的输入，不是另一份需要手工维护的内容源。新模式的项目只维护 Markdown 和允许的站内 SVG，不提供主题 CSS 或 JavaScript。

目录访问、内容图片收集与安全检查、泄漏扫描、覆盖快照、基线和输出替换继续采用现有流程与 Foundation 能力。模板本身不包含这些机制，也没有另建 CLI、配置读取器或发布器。旧站点未声明 `format` 时继续走完整 HTML 兼容路径；只有显式 `markdown-v1` 与 `editorial` 才调用本模板。

相邻测试位于 `test/editorial.test.mjs` 和 `test/markdown-v1.test.mjs`，虚构输入位于 `test/fixtures/editorial.mjs`。聚焦检查命令为：

```sh
node --test test/editorial.test.mjs test/markdown-v1.test.mjs
```

命令在渲染包目录、符合包内 `engines.node` 的运行时下执行。静态和输入测试不能代替浏览器的视觉、键盘及真实辅助技术验证。真实输入法、屏幕阅读器、跨应用粘贴和实际打印仍未完成设备验收。
