/**
 * 图片来源与用途判定（纯函数，可离线自检）。
 *
 * 为什么必须把这件事写死在代码里：素材库里的图**来源差别极大** ——
 *   self:local       用户自己导入/上传的本店图（唯一能当"我们店长什么样"的依据）
 *   gen:image        AI 生成图（示意图，可当底图/成品，但要标注非实拍）
 *   cover:composite  本地封面合成产物（自家产物）
 *   <平台>:ref       链接入库时抓下来的**同行爆款原图**（别人的作品）
 *   <平台>:buzz      舆情里抓的图（同样是别人的）
 *   <平台>:redownload / search:web  媒体重下 / 联网搜图（外部）
 *
 * 实测事故（任务 5）：素材只有一张 douyin:ref，模型拿它当封面底图，于是
 * 「我们的标题压在同行原图上」—— 既侵权又不像本店；同时生图那条线也把这张外图
 * 当"内容依据"，等于把同行的菜当成自家的菜。判定必须由代码做，不能指望模型从
 * 「本地图片: 1 张(assetId: 15)」这句话里猜出来。
 */

/** 自家产物（可作成品/底图/内容依据） vs 外部图（只能作结构参考） */
export type ImageOwnership = 'self' | 'generated' | 'composite' | 'external'

export function classifySourceMark(mark: unknown): ImageOwnership {
  const m = String(mark ?? '')
    .trim()
    .toLowerCase()
  if (!m) return 'external' // 未知来源一律按外部处理（保守：不让它当底图）
  if (m === 'self:local' || m.startsWith('self:')) return 'self'
  if (m === 'gen:image' || m.startsWith('gen:')) return 'generated'
  if (m.startsWith('cover:')) return 'composite'
  return 'external'
}

/** 能不能当"我们店"的画面依据（底图 / 内容参考 / 成品图） */
export function isSelfOwned(mark: unknown): boolean {
  return classifySourceMark(mark) !== 'external'
}

/** 给模型看的中文说明与用途限制（写进素材摘要，模型据此不会再误用） */
export function sourceLabel(mark: unknown): string {
  const m = String(mark ?? '')
    .trim()
    .toLowerCase()
  switch (classifySourceMark(m)) {
    case 'self':
      return '本店实拍/导入图（可用作底图与内容依据）'
    case 'generated':
      return 'AI 生成图（自家产物；对外发布需注明非实拍）'
    case 'composite':
      return '封面合成产物（自家产物，可作底图）'
    default: {
      const platform = m.split(':')[0] || '外部'
      const kind = m.endsWith(':buzz')
        ? '舆情抓取图'
        : m.endsWith(':redownload')
          ? '媒体重下图'
          : '原图'
      return platform + kind + '（他人作品：只能作结构参考，不得作底图、成品图或本店内容依据）'
    }
  }
}

/** 缺自家图时给模型/用户的可行动指引（各处复用同一句口径） */
export const NO_SELF_IMAGE_HINT =
  '素材里没有本店实拍图：把成品图/封面底图做出来需要一张本店照片（用户在素材详情里「上传本地素材」即可），' +
  '或者先用 growth_gen_image 生成一张（会被标注为示意图）。'
