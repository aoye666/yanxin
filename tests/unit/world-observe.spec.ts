/**
 * 观测投影的验收（T24a，spec §6.7）。
 *
 * 这个文件测的是"**她看不到什么**" —— 因为"她能看到什么"一眼就对，
 * 而全知是默认状态：不特意挡，模型就能读到整个世界。
 *
 * 五组：
 *   ① 句柄而非内部 id（含"内部 id 不出现在观测里"的反证）
 *   ② 位置投影隔离（屋里看不到街上有什么；同级只有名字；深处完全不可见）
 *   ③ 可见性过滤（hidden 永不出现；owner 属性只有主人可见）
 *   ④ 手机模态（看手机时看到的是消息，不是周围）
 *   ⑤ 话语过滤（别处的话听不到；说话人不在视野时不泄露身份）
 */
import { describe, expect, it } from 'vitest'
import { observe, type PhoneMessage } from '../../src/world/observe.ts'
import type { Utterance, WorldEntity, WorldSnapshot } from '../../src/world/state.ts'

/** 造一条实体（默认在地点里、无属性）。 */
function entity(
  id: string,
  kind: WorldEntity['kind'],
  name: string,
  location: string | null,
  extra: Partial<WorldEntity> = {},
): WorldEntity {
  return { id, kind, name, location, revision: 1, attributes: {}, ...extra }
}

/**
 * 一个够用的世界：小房子 + 很宽的街道（world.md 的设定）。
 *
 * ```
 * (根)
 *  ├─ house 小房子        ← 她在里面时
 *  │   ├─ bot 小研
 *  │   ├─ phone 手机（属于她）
 *  │   └─ cup 杯子
 *  └─ street 很宽的街道
 *      └─ shop 杂货店
 *          └─ goods 货架    ← 街上的店里，她在街上也看不到
 * ```
 */
function makeWorld(): WorldSnapshot {
  return {
    schemaVersion: 1,
    sequence: 7,
    effectiveAt: 3600,
    entities: {
      house: entity('house', 'place', '小房子', null),
      street: entity('street', 'place', '很宽的街道', null),
      bot: entity('bot', 'actor', '小研', 'house'),
      phone: entity('phone', 'object', '手机', 'house', { owner: 'bot' }),
      cup: entity('cup', 'object', '杯子', 'house'),
      shop: entity('shop', 'place', '杂货店', 'street'),
      goods: entity('goods', 'object', '货架', 'shop'),
    },
    actions: {},
    utterances: [],
  }
}

/** 观测里的名字列表。 */
function names(result: ReturnType<typeof observe>): string[] {
  return result.observation.entities.map((item) => item.name)
}

describe('T24a —— 句柄而非内部 id', () => {
  it('⭐ 观测里**没有内部 id**：模型只能靠句柄指目标', () => {
    const result = observe(makeWorld(), 'bot')
    const serialized = JSON.stringify(result.observation)

    // 内部 id 不该出现在给模型的那一半里
    for (const id of ['house', 'street', 'phone', 'cup', 'shop', 'goods']) {
      expect(serialized.includes(`"${id}"`), `观测里泄露了内部 id：${id}`).toBe(false)
    }
    expect(serialized).not.toContain('"bot"')
    // 句柄是 seen:n 形态
    expect(result.observation.entities[0]?.handle).toBe('seen:0')
  })

  it('句柄 → 真实 id 的映射单独给运行时（与观测物理分开）', () => {
    const result = observe(makeWorld(), 'bot')
    const self = result.observation.entities.find((item) => item.self)
    expect(self).toBeDefined()
    expect(result.handles.get(self?.handle ?? '')).toBe('bot')
    expect(result.handles.size).toBe(result.observation.entities.length)
  })

  it('位置用句柄表示（同一次观测内可解析）；不在观测内时不给', () => {
    const result = observe(makeWorld(), 'bot')
    const phone = result.observation.entities.find((item) => item.name === '手机')
    const house = result.observation.entities.find((item) => item.name === '小房子')
    expect(phone?.locationHandle).toBe(house?.handle) // 手机在房子里 → 指向"房子"那条
    expect(result.handles.get(phone?.locationHandle ?? '')).toBe('house')
  })

  it('她不在世界里 → 抛错（不返回空观测掩盖）', () => {
    expect(() => observe(makeWorld(), '不存在的人')).toThrow(/世界里没有/)
  })
})

describe('T24a —— 位置投影隔离（屋里 / 街上看到的完全不同）', () => {
  it('⭐ 在屋里：看得到屋里的东西；**街上的东西看不到**', () => {
    const result = observe(makeWorld(), 'bot')
    const visible = names(result)

    expect(visible).toContain('小研') // 自己
    expect(visible).toContain('小房子')
    expect(visible).toContain('手机')
    expect(visible).toContain('杯子')

    // 街上的店、店里的货架 —— 完全不可见
    expect(visible).not.toContain('杂货店')
    expect(visible).not.toContain('货架')
  })

  it('⭐ 同级地点**只有名字**（"窗外有一条很宽的街道"，但看不到街上有什么）', () => {
    const result = observe(makeWorld(), 'bot')
    const street = result.observation.entities.find((item) => item.name === '很宽的街道')

    expect(street).toBeDefined()
    expect(street?.distant).toBe(true) // 远景：只有名字
    expect(result.observation.entities.some((item) => item.name === '杂货店')).toBe(false)
  })

  it('在街上：看得到街上的店，但看不到屋里的东西（**对称的隔离**）', () => {
    const world = makeWorld()
    const onStreet: WorldSnapshot = {
      ...world,
      entities: { ...world.entities, bot: entity('bot', 'actor', '小研', 'street') },
    }

    const visible = names(observe(onStreet, 'bot'))
    expect(visible).toContain('很宽的街道')
    expect(visible).toContain('杂货店') // 同地点（店在街上）
    expect(visible).not.toContain('货架') // 店**里面**的东西看不到
    expect(visible).toContain('小房子') // 同级 → 只有名字
    expect(visible).not.toContain('手机') // 屋里的手机看不到
    expect(visible).not.toContain('杯子')
  })

  it('limit 生效（防上下文爆炸）', () => {
    const result = observe(makeWorld(), 'bot', { limit: 3 })
    expect(result.observation.entities).toHaveLength(3)
  })
})

describe('T24a —— 可见性过滤（属性级）', () => {
  it('⭐ `hidden` 属性**永不出现**（谁都不该从观测里读到世界真相）', () => {
    const world = makeWorld()
    world.entities['cup'] = entity('cup', 'object', '杯子', 'house', {
      attributes: {
        颜色: { value: '白', visibility: 'public' },
        里面藏着什么: { value: '一把钥匙', visibility: 'hidden' },
      },
    })

    const cup = observe(world, 'bot').observation.entities.find((item) => item.name === '杯子')
    expect(cup?.attributes['颜色']).toBe('白')
    expect(cup?.attributes['里面藏着什么']).toBeUndefined()
    expect(JSON.stringify(cup)).not.toContain('钥匙')
  })

  it('⭐ `owner` 属性只有**主人自己**看得到（别人的东西里有什么，她不知道）', () => {
    const world = makeWorld()
    world.entities['cup'] = entity('cup', 'object', '杯子', 'house', {
      owner: '别人', // 不属于她
      attributes: {
        颜色: { value: '白', visibility: 'public' },
        私人物: { value: '信件', visibility: 'owner' },
      },
    })
    // 加一个"别人"（另一个 actor，也在屋里）
    world.entities['别人'] = entity('别人', 'actor', '别人', 'house')

    const cup = observe(world, 'bot').observation.entities.find((item) => item.name === '杯子')
    expect(cup?.attributes['颜色']).toBe('白') // public 可见
    expect(cup?.attributes['私人物']).toBeUndefined() // 她不是主人 → 看不到
    expect(JSON.stringify(cup)).not.toContain('信件')
  })

  it('自己的东西的 owner 属性看得到（"手机里存了什么"她当然知道）', () => {
    const world = makeWorld()
    world.entities['phone'] = entity('phone', 'object', '手机', 'house', {
      owner: 'bot',
      attributes: { 通讯录: { value: '主人', visibility: 'owner' } },
    })

    const phone = observe(world, 'bot').observation.entities.find((item) => item.name === '手机')
    expect(phone?.attributes['通讯录']).toBe('主人')
  })
})

describe('T24a —— 手机模态（看到的是消息，不是周围）', () => {
  const messages: PhoneMessage[] = [
    { id: 'm1', speaker: '某人', text: '今晚打游戏吗', at: 3500 },
    { id: 'm2', speaker: '另一个人', text: '在的', at: 3550 },
  ]

  it('⭐ `focus: phone`：只有手机与消息，**没有周围的东西**', () => {
    const result = observe(makeWorld(), 'bot', { focus: 'phone', phoneMessages: messages })

    expect(names(result)).toEqual(['手机']) // 手机在身边 → 看得到它
    expect(result.observation.entities.some((item) => item.name === '杯子')).toBe(false)
    expect(result.observation.entities.some((item) => item.name === '很宽的街道')).toBe(false)

    const spoken = result.observation.utterances
    expect(spoken.map((item) => item.text)).toEqual(['今晚打游戏吗', '在的'])
    expect(spoken[0]?.fromPhone).toBe(true)
    expect(spoken[0]?.speaker).toBe('某人')
  })

  it('手机不在身边 → 观测里没有手机（她够不着）', () => {
    const world = makeWorld()
    world.entities['phone'] = entity('phone', 'object', '手机', 'street') // 手机落在街上
    const result = observe(world, 'bot', { focus: 'phone', phoneMessages: messages })

    expect(result.observation.entities).toEqual([])
    expect(result.observation.utterances).toHaveLength(2) // 消息还在（她"听得到"）
  })

  it('手机消息按条数上限截断（只给最近的）', () => {
    const many: PhoneMessage[] = Array.from({ length: 30 }, (_, index) => ({
      id: `m${index}`,
      speaker: '话很多的人',
      text: `第 ${index} 条`,
      at: 1000 + index,
    }))
    const result = observe(makeWorld(), 'bot', { focus: 'phone', phoneMessages: many, utteranceLimit: 5 })
    expect(result.observation.utterances).toHaveLength(5)
    expect(result.observation.utterances[0]?.text).toBe('第 25 条')
  })
})

describe('T24a —— 话语过滤', () => {
  const utterances: Utterance[] = [
    { id: '1:0', speakerId: 'bot', text: '屋里的自言自语', at: 100, location: 'house' },
    { id: '2:0', speakerId: '别人', text: '街上的话', at: 200, location: 'street' },
    { id: '3:0', speakerId: '别人', text: '不知道在哪儿说的', at: 300 },
  ]

  it('⭐ 别处的话听不到；地点不明的话听得到（老日志不该因缺字段消失）', () => {
    const world = makeWorld()
    world.entities['别人'] = entity('别人', 'actor', '别人', 'street')
    world.utterances = utterances

    const heard = observe(world, 'bot').observation.utterances.map((item) => item.text)
    expect(heard).toContain('屋里的自言自语')
    expect(heard).not.toContain('街上的话') // 街上说的，她在屋里听不到
    expect(heard).toContain('不知道在哪儿说的')
  })

  it('说话人不在视野内 → **不泄露身份**（她听到声音，但不知道是谁）', () => {
    const world = makeWorld()
    world.entities['别人'] = entity('别人', 'actor', '别人', 'street') // 在街上（她看不到）
    world.utterances = [utterances[2] as Utterance]

    const spoken = observe(world, 'bot').observation.utterances[0]
    expect(spoken?.speaker).toBe('看不见的人')
  })

  it('说话人在视野内 → 给句柄（她能对上"是谁在说"）', () => {
    const world = makeWorld()
    world.entities['别人'] = entity('别人', 'actor', '别人', 'house') // 也在屋里
    world.utterances = [utterances[2] as Utterance]

    const spoken = observe(world, 'bot').observation.utterances[0]
    const speakerEntity = observe(world, 'bot').observation.entities.find((item) => item.name === '别人')
    expect(spoken?.speaker).toBe(speakerEntity?.handle)
  })
})