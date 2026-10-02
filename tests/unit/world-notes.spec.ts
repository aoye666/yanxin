/**
 * 世界笔记的验收（T27，spec §6.7）。
 *
 * 她是**写给自己看**的（也是给你看的 —— 人机共用）。所以这里测的重点不是"能写文件"，
 * 而是三件会影响她过日子的事：
 *
 *   · **文件名 = 标题**：她翻本子看到的就是自己写下的标题（而不是一串 id / hash）
 *   · **同名覆盖**：她改主意时重写同名的那篇 —— 不该攒出 `今天-2.md` 这种垃圾
 *   · **原子落盘**：读者（她、你、编辑器）永远看不到半个文件
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_NOTE_BYTES, NOTES_DIR, WorldNotes, noteFileName } from '../../src/world/notes.ts'

const dirs: string[] = []

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

async function makeNotes(): Promise<{ dir: string; notes: WorldNotes }> {
  const dir = await mkdtemp(join(tmpdir(), 'yanxin-notes-'))
  dirs.push(dir)
  return { dir, notes: await WorldNotes.open(dir) }
}

describe('T27 —— 标题变成文件名', () => {
  it('干净的标题原样用（她看到的文件名就是她写下的标题）', () => {
    expect(noteFileName('今天')).toBe('今天.md')
    expect(noteFileName('关于那条街')).toBe('关于那条街.md')
  })

  it('非法字符被替换（路径分隔符不能变成目录穿越）', () => {
    expect(noteFileName('../../etc/passwd')).toBe('etc-passwd.md')
    expect(noteFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j.md')
  })

  it('首尾的点与空白被去掉（Windows 不允许尾点，且 `..` 有特殊含义）', () => {
    expect(noteFileName('  ..  ')).not.toContain('..')
    expect(noteFileName('.hidden.')).toBe('hidden.md')
  })

  it('Windows 设备名与写不出名字的标题退回**确定性**短名（同标题同文件）', () => {
    const reserved = noteFileName('CON')
    expect(reserved).toMatch(/^note-[0-9a-f]{12}\.md$/)
    expect(noteFileName('CON')).toBe(reserved)
    expect(noteFileName('')).toBe(noteFileName(''))
  })

  it('超长标题被截断（路径长度有限，且文件名不该变成一整段话）', () => {
    const long = '很长的标题'.repeat(40)
    expect(Buffer.byteLength(noteFileName(long), 'utf8')).toBeLessThan(200)
  })
})

describe('T27 —— 写与翻', () => {
  it('⭐ 写一篇：文件名即标题，正文原样（没有机器加的壳）', async () => {
    const { dir, notes } = await makeNotes()
    const { path } = await notes.write('今天', '外面很安静。\n\n想了一会儿事。')

    expect(path).toBe(join(dir, NOTES_DIR, '今天.md'))
    expect(await readFile(path, 'utf8')).toBe('外面很安静。\n\n想了一会儿事。')
  })

  it('⭐ 同名覆盖：重写同名的那篇不会攒出第二份文件', async () => {
    const { notes } = await makeNotes()
    await notes.write('今天', '第一版')
    await notes.write('今天', '第二版')

    expect(await notes.list()).toEqual(['今天'])
    const notesDir = notes.path
    expect(await readdir(notesDir)).toEqual(['今天.md'])
  })

  it('列出标题时最近写的在前（她翻本子想看刚写的那篇）', async () => {
    const { notes } = await makeNotes()
    await notes.write('早些', 'a')
    // 文件系统的时间戳精度因平台而异：隔开一点再写第二篇，别让两篇落在同一毫秒
    await new Promise((resolve) => setTimeout(resolve, 15))
    await notes.write('晚些', 'b')

    expect(await notes.list()).toEqual(['晚些', '早些'])
  })

  it('只认 .md：临时文件与别人的杂物不算她的笔记', async () => {
    const { notes } = await makeNotes()
    await notes.write('真笔记', 'x')
    await writeFile(join(notes.path, '草稿.tmp'), 'x', 'utf8')
    await writeFile(join(notes.path, '你的文件.txt'), 'x', 'utf8')
    await writeFile(join(notes.path, '照片.md'), 'x', 'utf8') // md 也算（你手写的也算一篇）

    expect(await notes.list()).toEqual(expect.arrayContaining(['真笔记', '照片.md'.slice(0, -3)]))
    expect(await notes.list()).not.toContain('草稿')
  })

  it('⭐ 原子落盘：写完之后目录里没有 .tmp 残留', async () => {
    const { notes } = await makeNotes()
    await notes.write('半途而废', '写完的')
    expect((await readdir(notes.path)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('正文过大时**报错**（不静默截断 —— 她写下的与本子上的必须一致）', async () => {
    const { notes } = await makeNotes()
    await expect(notes.write('太大', 'x'.repeat(MAX_NOTE_BYTES + 1))).rejects.toThrow(/太长了/)
  })

  it('空的笔记本是"空的"，不是错误', async () => {
    const { notes } = await makeNotes()
    expect(await notes.list()).toEqual([])
  })
})