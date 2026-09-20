/** 给素材画廊加「来源角标」：stage 上一枚 + 缩略图说明 + 灯箱 note */
import { readFileSync, writeFileSync } from 'node:fs'
const p = 'src/renderer/src/components/growth/MediaGallery.tsx'
let s = readFileSync(p, 'utf8')

const anchor1 = '      <div className="gth-gallery-stage">\n'
if (!s.includes(anchor1)) { console.error('ANCHOR1_NOT_FOUND'); process.exit(2) }
const badge = [
  '      <div className="gth-gallery-stage">',
  '        {/* 来源角标：一眼看出这张是自家的还是同行的（同行原图不能当底图/成品图） */}',
  '        {cur ? (',
  '          <span',
  "            className={'gth-gallery-src' + (isSelfOwned(cur.sourceMark) ? ' is-self' : '')}",
  '            title={sourceLabel(cur.sourceMark)}',
  '          >',
  '            {srcLabel(cur)}',
  '          </span>',
  '        ) : null}',
  ''
].join('\n')
s = s.replace(anchor1, badge)

const anchor2 = '          items={imgs.map((a) => ({ relPath: a.relPath }))}'
if (s.includes(anchor2)) {
  s = s.replace(anchor2, '          items={imgs.map((a) => ({ relPath: a.relPath, note: srcLabel(a) }))}')
}
const anchor3 = '              alt="缩略图"'
if (s.includes(anchor3)) {
  s = s.replace(anchor3, '              alt={\'缩略图 · \' + srcLabel(a)}\n              title={srcLabel(a)}')
}
writeFileSync(p, s, 'utf8')
console.log('gallery patched')
