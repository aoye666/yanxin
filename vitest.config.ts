import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // 把 $DSH_HOME 接管到临时目录：防止落盘类代码（url-guard 审计、memory outbox）
    // 在测试里污染真实的 ~/.dsh。必须在被测模块 import 前执行 —— 见该文件。
    setupFiles: ['tests/support/isolate-dsh-home.ts'],
    // URL 守卫的用例里有对公网域名做 DNS 解析的断言（example.com 等），
    // 所以不走 isolate 也能跑；但保持默认的隔离更安全。
    testTimeout: 20_000,
  },
})
