/** 给素材画廊加「删除这张」（至少保留一张图；挂在产出上的图由主进程拒绝） */
import { readFileSync, writeFileSync } from 'node:fs'
const p = 'src/renderer/src/components/growth/MediaGallery.tsx'
let s = readFileSync(p, 'utf8')

// 1) props 增加 onChanged
const a1 = '  /** 远程视频直链(平台视频素材, 本地不保存视频文件) */\n  remoteVideoUrl: string\n}'
if (!s.includes(a1)) { console.error('A1'); process.exit(2) }
s = s.replace(a1, '  /** 远程视频直链(平台视频素材, 本地不保存视频文件) */\n  remoteVideoUrl: string\n  /** 删除某张图后通知父级重拉详情（列表封面/张数都要跟着变） */\n  onChanged?: () => void\n}')

// 2) 解构 onChanged
const a2 = 'export function MediaGallery({\n  assets,\n  remoteImageUrls,\n  remoteVideoUrl\n}: MediaGalleryProps)'
if (!s.includes(a2)) { console.error('A2'); process.exit(2) }
s = s.replace(a2, 'export function MediaGallery({\n  assets,\n  remoteImageUrls,\n  remoteVideoUrl,\n  onChanged\n}: MediaGalleryProps)')

// 3) 删除动作
const a3 = '  const localVideo = assets.find((a) => a.kind === \'video\' && a.relPath) ?? null'
if (!s.includes(a3)) { console.error('A3'); process.exit(2) }
const del = [
  a3,
  '',
  '  /** 删掉当前这张（误下载的、误生成的、同行的参考图都可以删）：至少保留一张，且挂在产出上的删不掉 */',
  '  const removeCurrent = async (): Promise<void> => {',
  '    if (!growthApi?.removeAsset || !cur) return',
  '    const ok = await confirmAsk({',
  '      title: \'删除这张图？\',',
  '      message:',
  '        \'仅从这条素材里移除（本地文件按内容去重，可能仍被其它素材共用，所以不删文件）。\' +',
  '        (count <= 1 ? \'这是最后一张图，删不掉。\' : \'\'),',
  '      okLabel: \'删除\',',
  '      danger: true',
  '    })',
  '    if (!ok) return',
  '    const res = await growthApi.removeAsset(cur.id)',
  '    if (!res.ok) {',
  '      toast.error(res.error || \'删除失败\')',
  '      return',
  '    }',
  '    toast.success(\'已删除这张图\')',
  '    setFailed(false)',
  '    setIdx(0)',
  '    onChanged?.()',
  '  }',
].join('\n')
s = s.replace(a3, del)

// 4) 按钮：放在「复制当前图」旁边
const a4 = `      <button\n        className="ui-btn gth-btn sm gth-gallery-copy"`
if (!s.includes(a4)) { console.error('A4'); process.exit(2) }
const btn = [
  '      <div className="gth-gallery-ops">',
  '        <button',
  '          className="ui-btn gth-btn sm"',
  '          type="button"',
  '          disabled={!cur || count <= 1}',
  '          title={count <= 1 ? \'至少要保留一张图\' : \'从这条素材里删掉当前这张\'}',
  '          onClick={() => void removeCurrent()}',
  '        >',
  '          删除这张',
  '        </button>',
  '        <button',
  '          className="ui-btn gth-btn sm gth-gallery-copy"',
].join('\n')
s = s.replace(a4, btn)

// 5) 复制按钮收尾：补上 ops 容器闭合（原按钮后面紧跟 '复制当前图到剪贴板' 与 </button>）
const a5 = '        复制当前图到剪贴板\n      </button>'
if (!s.includes(a5)) { console.error('A5'); process.exit(2) }
s = s.replace(a5, '          复制当前图到剪贴板\n        </button>\n      </div>')

// 6) import confirmAsk
const a6 = "import { toast } from '../../stores/toast'"
if (!s.includes(a6)) { console.error('A6'); process.exit(2) }
s = s.replace(a6, a6 + "\nimport { confirmAsk } from '../../stores/confirmDialog'")

writeFileSync(p, s, 'utf8')
console.log('gallery delete wired')
