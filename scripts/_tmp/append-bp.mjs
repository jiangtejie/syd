import { readFileSync, writeFileSync } from 'fs'
const blocks = {
  'src/renderer/src/pages/export.css': [
    '',
    '/* ── 窄窗口（≤1080，含 1366 屏左右分屏）──',
    ' * 两栏并排会让会话列表与设置各只剩 300px 出头，改成上下单栏；',
    ' * 设置栏不再 sticky（页面本来就短，跟着滚更自然）。',
    ' * 追加在文件末尾：同优先级下只有写在后面才压得住上面的 .exp-opts{position:sticky}。 */',
    '@media (max-width: 1080px) {',
    '  .exp-chat-layout {',
    '    grid-template-columns: minmax(0, 1fr);',
    '  }',
    '  .exp-opts {',
    '    position: static;',
    '  }',
    '}',
    ''
  ].join('\n'),
  'src/renderer/src/pages/growth/tables.css': [
    '',
    '/* ── 窄窗口（≤1200）──',
    ' * 素材表 6 列里 4 列是定宽（互动四格/入库时间/爆款分/用途），再挤标题就会被压成一行两三个字。',
    ' * 这一档改成**整块横向滚动**：保住列宽，左右划一下比逐列变窄好读得多。',
    ' * 追加在文件末尾：同优先级下只有写在后面才压得住上面的 .gth-row{min-width:0}。 */',
    '@media (max-width: 1200px) {',
    '  .gth-list {',
    '    overflow-x: auto;',
    '  }',
    '  .gth-row {',
    '    min-width: 940px;',
    '  }',
    '  .gth-row--sub,',
    '  .gth-row--task {',
    '    min-width: 640px;',
    '  }',
    '}',
    ''
  ].join('\n')
}
for (const [f, block] of Object.entries(blocks)) {
  const t = readFileSync(f, 'utf8')
  writeFileSync(f, t.replace(/\s*$/, '') + '\n' + block)
  console.log(f + ' ← 追加窄窗口规则')
}
