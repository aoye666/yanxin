/**
 * 危险等级判定（spec §6.10：每条 shell 命令的审计要含**危险等级**）。
 *
 * 这是**打标**，不是拦截 —— 用户已明确选择"只审计不确认"（spec §7.4-B）。
 * 所以这个文件不该有任何"throws / deny"的能力：它只把文本映射成一个等级与若干标签。
 *
 * 为什么不做得更聪明：判据是**命令文本**，而文本可以被绕（`r''m -rf /`、变量拼接、
 * 写进脚本再执行）。把它当"给读审计的人第一眼提示"是诚实的用法；
 * 把它当"安全控制"就会重演 ADR 0005 那条教训 —— **控制必须在代码里，
 * 而这里根本没有控制，只有记录**。
 *
 * ⚠️ 只用命名导出（ADR 0004）。
 */

/** 危险等级：低（普通命令）/ 中（值得看一眼）/ 高（可能不可逆或影响面大）。 */
export type DangerLevel = 'low' | 'medium' | 'high'

export interface DangerVerdict {
  level: DangerLevel
  /** 命中的标签（可多个），给读审计的人一个"为什么判成这样"的抓手。 */
  tags: string[]
}

interface Rule {
  level: DangerLevel
  tag: string
  test: RegExp
}

/**
 * 规则表。
 *
 * 取向是**宁可多打标签，不要漏掉不可逆的那几类** —— 打错的代价是多看一眼审计，
 * 漏掉的代价是事后不知道为什么机器没了。
 */
const RULES: readonly Rule[] = [
  // ── 高 ────────────────────────────────────────────────────────────────
  // ⚠️ flag 组认 `-{1,2}[A-Za-z][A-Za-z-]*`（短与 GNU 长选项都吞）：只认短形态时
  //    `rm --recursive --no-preserve-root /` 与 `rm -rf --no-preserve-root /`
  //    都会漏判 high（长选项或夹在中间的 flag 挡住了目标路径的匹配）
  { level: 'high', tag: 'rm-根或家目录', test: /\brm\s+(?:-{1,2}[A-Za-z][A-Za-z-]*\s+)*(?:\/|~|\/etc|\/usr|\/var|\$HOME|"\$HOME")/ },
  { level: 'high', tag: '文件系统', test: /\b(?:mkfs|diskpart|format)\b|\bdd\b[^\n]*\bof=\/dev\// },
  { level: 'high', tag: '关机或重启', test: /\b(?:shutdown|reboot|halt|poweroff)\b/ },
  { level: 'high', tag: '杀进程', test: /\btaskkill\b[^\n]*\/[FI]|\bkill\s+-9\s+-1\b/ },
  { level: 'high', tag: 'fork bomb', test: /:\(\)\s*\{[^\n]*\|[^\n]*&/ },
  { level: 'high', tag: '远程脚本直通 shell', test: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/ },
  { level: 'high', tag: '权限全开', test: /\bchmod\s+(?:-R\s+)?777\s+\// },
  { level: 'high', tag: '覆写系统文件', test: />\s*\/etc\// },

  // ── 中 ────────────────────────────────────────────────────────────────
  { level: 'medium', tag: '提权', test: /\bsudo\b/ },
  // 递归强删的两种形态：短 flag（-rf 任意组合）与 GNU 长选项（--recursive + --force 同在）
  { level: 'medium', tag: '递归强删', test: /\brm\s+-[A-Za-z]*r[A-Za-z]*f|\brm\s+-[A-Za-z]*f[A-Za-z]*r|\brm\b(?=[^\n]*--recursive\b)(?=[^\n]*--force\b)/ },
  { level: 'medium', tag: '权限放宽', test: /\bchmod\s+(?:-R\s+)?777|\bchown\s+-R\b/ },
  { level: 'medium', tag: '强制推送', test: /\bgit\s+push\b[^\n]*--force/ },
  { level: 'medium', tag: '对外连接', test: /\b(?:curl|wget|nc|ncat|telnet|ssh|scp|rsync|ftp)\b/ },
  { level: 'medium', tag: '凭据文件', test: /\.ssh\/|id_rsa|\.git-credentials|\.aws\/|\.env\b|credentials\.json/ },
  { level: 'medium', tag: '全量环境变量', test: /\b(?:printenv|env)\b\s*(?:\||>|$)/ },
  { level: 'medium', tag: '安装任意代码', test: /\b(?:pip|pipx|npm|pnpm|yarn|cargo|go)\s+(?:install|i|add|publish)\b/ },
  { level: 'medium', tag: '结束进程', test: /\b(?:kill|pkill|killall)\b/ },
]

/** 判一条命令的危险等级。没命中任何规则就是 `low`（标签为空）。 */
export function classifyCommand(command: string): DangerVerdict {
  const tags: string[] = []
  let level: DangerLevel = 'low'
  for (const rule of RULES) {
    if (!rule.test.test(command)) continue
    tags.push(rule.tag)
    if (rule.level === 'high') level = 'high'
    else if (level !== 'high') level = 'medium'
  }
  return { level, tags }
}