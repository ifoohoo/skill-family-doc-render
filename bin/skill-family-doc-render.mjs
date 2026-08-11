#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// CLI 入口：从 process.cwd() 解析 public-release.json，
// 转发 --check / --repo <name> / --assert-git 到渲染器主流程。
import { main, RenderError } from '../scripts/render-public-site.mjs';

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`skill-family-doc-render — config-driven GitHub Pages knowledge-site renderer

Usage:
  skill-family-doc-render                render every repo with a site field (writes)
  skill-family-doc-render --check        read-only drift check against site-baseline.json
  skill-family-doc-render --repo <name>  render / check a single repo by name
  skill-family-doc-render --assert-git   also assert rendered files are git-tracked

Reads public-release.json from the current working directory.`);
  process.exitCode = 0;
} else {
  main(argv, { cwd: process.cwd() })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err.message);
      process.exitCode = err instanceof RenderError ? err.exitCode : 1;
    });
}
