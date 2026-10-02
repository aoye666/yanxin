/**
 * 全局测试隔离：把 `DSH_HOME` 指到一个一次性临时目录。
 *
 * 为什么需要：项目里有几处代码会往 `$DSH_HOME/yanxin/...` **写文件** ——
 * `url-guard` 的审计日志、`memory/outbox` 的写回缓冲（T42）。它们的默认路径都从
 * `process.env.DSH_HOME ?? ~/.dsh` 推导，所以测试若不接管这个变量，
 * 症状就是**跑一次单测污染了生产数据**（对记忆缓冲而言，是"她莫名记住了测试内容"）。
 *
 * 在这一处接管，而不是每个测试各自传临时目录：新增的落盘代码自动被覆盖，
 * 不会因为"忘了传"而漏。个别要断言具体路径的测试仍可显式配置覆盖。
 *
 * ⚠️ 用 `setupFiles` 而不是放在某个 spec 里：必须在**被测模块 import 之前**执行 ——
 * `url-guard.ts` 的审计路径是模块级常量，import 时就固化了。
 *
 * ⚠️ 目录只建不删（留在系统临时区）：清理要跨进程协调，收益不值当；
 * 真正的隔离目的是"不写到 ~/.dsh"，不是"不占临时空间"。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'yanxin-test-dsh-'))
