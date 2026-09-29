#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// CLI 入口：全部 argv 原样委托给 main()。闭集解析、--help/-h、
// --check-project / --read-proof 互斥路由均由 main() 裁决。
import { main, RenderError } from '../scripts/render-public-site.mjs';

main(process.argv.slice(2), { cwd: process.cwd() })
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err.message);
    process.exitCode = err instanceof RenderError ? err.exitCode : 1;
  });
