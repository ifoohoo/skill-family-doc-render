// SPDX-License-Identifier: Apache-2.0
// @feature DOC1 @scenario S-01 S-02
// 向后兼容入口：markdown-v1 统一委托至现代 Markdown 编译内核（markdown-compiler.mjs）。
export {
  compileMarkdown as compileMarkdownV1,
  compileMarkdown,
  MarkdownCompileError,
  MarkdownV1Error,
  replaceMarkdownTokens,
} from './markdown-compiler.mjs';
