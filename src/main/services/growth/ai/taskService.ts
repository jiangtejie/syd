/**
 * 营销 AI 工作台 · 任务服务: 建任务(含会话与开场白) / 任务详情 / 候选点选 / 产出更新。
 */

import { appendChatMessage, createChat, removeChat } from '../../../db/repos/chatRepo'
import {
  bindTaskSession,
  createTask,
  getTask,
  keepOnlyOutputAsset,
  listOutputsByTask,
  listStores,
  removeOutput,
  removeTask,
  setChatScope,
  setOutputStatus,
  type GrowthAiTaskView,
  type GrowthOutputView
} from '../../../db/repos/growthAiRepo'
import { getContentDetail } from '../../../db/repos/growthRepo'
import { ANALYZE_VER, analyzeContent } from '../remix/service'
import { hasVisualFacts, readVisualFacts } from './imageStrategy'
import { itemBrief, storeBrief } from './growthTools'
import { createLogger } from '../../logging'

const log = createLogger('growth-ai')

export interface CreateTaskResult {
  ok: boolean
  taskId?: number
  sessionId?: number
  error?: string
}

/** 从素材创建爆改任务: 补拆解 → 建任务 → 建会话(scope=growth) → 预置开场白 */
export async function createTaskFromContent(input: {
  contentId: number
  storeId?: number | null
  goal?: string
}): Promise<CreateTaskResult> {
  const detail = getContentDetail(input.contentId)
  if (!detail) return { ok: false, error: '素材不存在' }
  const storeId = input.storeId ?? listStores().find((s) => s.enabled)?.id ?? null
  const goal = input.goal ?? 'image_text'

  // 缺拆解卡、或卡是**旧版本**（没有视觉维度）时补一次，失败不阻塞建任务。
  // 为什么要认版本：拆解输出结构升级（v2 加了 visual）后，老卡不会自己变新，
  // 图生图的「保持」就永远只能退回通用口径。建任务是唯一自然的重拆时机，顺手自愈。
  const staleDecomp =
    !detail.decomp?.structure ||
    detail.decomp.modelVer !== ANALYZE_VER ||
    !hasVisualFacts(readVisualFacts(detail.decomp.visual))
  if (staleDecomp) {
    try {
      await analyzeContent(input.contentId)
    } catch (e) {
      log.warn('analyze on task create failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const title = detail.title || '未命名素材'
  const taskId = createTask({ contentId: input.contentId, storeId, title, goal })
  const sessionId = createChat('', title)
  setChatScope(sessionId, 'growth')
  bindTaskSession(taskId, sessionId)

  const opening = [
    '已把这条素材放进工作台, 拆解卡与门店事实已加载。',
    '',
    '【素材】',
    itemBrief(input.contentId).slice(0, 900),
    '',
    '【门店事实】',
    storeBrief(storeId).slice(0, 600),
    '',
    '可以直接告诉我改什么, 例如:',
    '· 换 5 个标题, 突出人均与场景',
    '· 把正文改成探店种草风, 控制在 120 字',
    '· 封面用门店实拍, 没有就生成一张暖色火锅氛围图',
    '· 补上地址和营业时间(缺的我联网查, 你确认后写入档案)'
  ].join('\n')
  appendChatMessage(sessionId, 'assistant', 'text', opening, { growthOpening: true })
  return { ok: true, taskId, sessionId }
}

export function deleteTask(taskId: number): { ok: boolean; error?: string } {
  const task = getTask(taskId)
  if (!task) return { ok: false, error: '任务不存在(可能已被删除)' }
  try {
    removeTask(taskId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.warn('deleteTask removeTask failed id=' + String(taskId) + ': ' + msg)
    return { ok: false, error: '删除任务失败: ' + msg }
  }
  // 会话清理失败不影响任务删除结果
  if (task.sessionId) {
    try {
      removeChat(task.sessionId)
    } catch (e) {
      log.warn(
        'deleteTask removeChat failed sid=' +
          String(task.sessionId) +
          ': ' +
          (e instanceof Error ? e.message : String(e))
      )
    }
  }
  log.info('task deleted id=' + String(taskId))
  return { ok: true }
}

export interface TaskBundle {
  task: GrowthAiTaskView
  outputs: GrowthOutputView[]
  candidates: GrowthOutputView[]
}

export function getTaskBundle(taskId: number): TaskBundle | null {
  const task = getTask(taskId)
  if (!task) return null
  return {
    task,
    outputs: listOutputsByTask(taskId, 'selected'),
    candidates: listOutputsByTask(taskId, 'candidate')
  }
}

/**
 * 候选点选: select=采用 / archive=弃用 / delete=删除 / pick=只采用指定的那一张图。
 *
 * 为什么要 pick：一次生图会把 N 张图落在**同一个产出块**里，而「采用」是块级状态 ——
 * 用户点其中一张，整块 N 张一起进产出（导出包里就多出 N-1 张他根本没选的图）。
 * pick 先把块里其它图删掉，再采用，语义才和界面上的「用这张」一致。
 */
export function resolveCandidate(
  taskId: number,
  outputId: number,
  action: 'select' | 'archive' | 'delete' | 'pick',
  assetId?: number
): { ok: boolean; error?: string } {
  const all = listOutputsByTask(taskId)
  const hit = all.find((o) => o.id === outputId)
  if (!hit) return { ok: false, error: '候选不存在' }
  if (action === 'delete') removeOutput(outputId)
  else if (action === 'pick') {
    if (!assetId) return { ok: false, error: '缺少要采用的图片 id' }
    const dropped = keepOnlyOutputAsset(outputId, assetId)
    if (dropped < 0) return { ok: false, error: '这张图不属于该候选（可能已被替换）' }
    setOutputStatus(outputId, 'selected')
    log.info(
      'candidate picked output=' +
        String(outputId) +
        ' asset=' +
        String(assetId) +
        ' dropped=' +
        String(dropped)
    )
  } else setOutputStatus(outputId, action === 'select' ? 'selected' : 'archived')
  return { ok: true }
}

/** 回退: 已采用产出退回候选池 */
export function revertOutput(outputId: number): { ok: boolean } {
  setOutputStatus(outputId, 'candidate')
  return { ok: true }
}
