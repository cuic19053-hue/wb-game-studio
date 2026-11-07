/** Runtime UI languages. The templates ship in Chinese; other languages are
 * applied by string substitution at build time, so exported games stay
 * self-contained with no runtime locale files. */

export const LANGS = ['zh', 'en']

const PAIRS = [
  ['收集灯笼，躲开荆棘怪！', 'Collect lanterns, avoid the thorn creatures!'],
  ['WASD / 方向键 或 拖动移动', 'WASD / arrows or drag to move'],
  ['P 暂停', 'P to pause'],
  ['M 静音', 'M to mute'],
  ['按任意键 / 点击开始', 'Press any key / tap to start'],
  ['按任意键 / 点击再来一次', 'Press any key / tap to restart'],
  ['按任意键 / 点击再玩一次', 'Press any key / tap to play again'],
  ['按任意键 / 点击再试一次', 'Press any key / tap to try again'],
  ['按 P 继续', 'Press P to continue'],
  ['已暂停', 'Paused'],
  ['得分 ', 'Score '],
  ['平安入夜', 'Night falls safely'],
  ['被抓到了！', 'Caught!'],
  ['灯笼：', 'Lanterns: '],
  ['你收集了 ', 'You collected '],
  [' 盏灯笼', ' lanterns'],
  ['。最佳：', '. Best: '],
]

export function localize(code, lang) {
  if (!lang || lang === 'zh') return code
  if (lang === 'en') {
    let out = code
    for (const [zh, en] of PAIRS) out = out.split(zh).join(en)
    return out
  }
  return code
}
