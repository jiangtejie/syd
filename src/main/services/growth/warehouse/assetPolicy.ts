/**
 * 删除素材图片的准入规则（纯函数，可离线自检）。
 *
 * 从 IPC handler 里抽出来是因为这两条护栏都**不该靠在界面上小心**：
 *  ① 至少保留一张展示图 —— 素材列表/详情的封面都用它，删空了界面就成了空壳；
 *  ② 挂在产出上的图不能删 —— 产出面板还在引用它，删了就是裂图（用户得先在产出里换掉）。
 * 规则错了不会报错，只会「悄悄把不该删的删了」，所以要能被断言。
 */
export interface AssetRemovalFacts {
  /** growth_asset.kind */
  kind: string
  /** 删掉这张**之后**该素材还剩几张可展示的图（cover/image 且 rel_path 非空）；0 = 这是最后一张 */
  remainingImages: number
  /** 有多少条产出资产行引用这张图 */
  outputRefs: number
}

/** 返回拒绝原因；null = 可以删 */
export function checkAssetRemoval(facts: AssetRemovalFacts): string | null {
  if (facts.outputRefs > 0) {
    return (
      '这张图正挂在 ' +
      String(facts.outputRefs) +
      ' 个产出上：先到右侧产出面板把它移除或换掉，再回来删除（否则产出会裂图）'
    )
  }
  const isImage = facts.kind === 'cover' || facts.kind === 'image'
  // 判据是「删完还剩几张」：删完还有 1 张就允许（两张删到一张是正常操作），删完为 0 才拦
  if (isImage && facts.remainingImages < 1) {
    return '至少要保留一张图：这是该素材唯一的展示图'
  }
  return null
}
