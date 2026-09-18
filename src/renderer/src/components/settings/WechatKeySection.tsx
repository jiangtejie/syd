import { useCallback, useEffect, useState } from 'react'
import { useWorkbenchStore } from '../../stores/workbench'
import { toast } from '../../stores/toast'
import { SettingsCard } from './ui'
import type { KeyAccountInfo, KeyStatusInfo } from '../../../../shared/types'
import { useAsyncEffect } from '../../lib/useAsyncEffect'

/**
 * 微信数据与密钥（方案 §4.9：密钥外部注入，客户端不内嵌取 key）。
 * 参考 CipherTalk DatabaseTab 的交互模式：路径浏览、密钥显隐、状态卡片、测试连接；
 * 差异：不提供内存扫描取 key，手动导入 + 状态校验。
 */

const keyStoreApi = window.api?.cs?.keyStore
const wxApi = window.api?.cs?.wx
const dialogApi = window.api?.cs?.dialog
const configApi = window.api?.cs?.config
const mediaApi = window.api?.cs?.media

/** XOR 密钥格式校验：0x 前缀 hex / 1-2 位 hex / 1-3 位十进制（解析语义与主进程一致） */
function validateXor(v: string): string | null {
  if (!v.trim()) return null
  const s = v.trim()
  const ok =
    /^0[xX][0-9a-fA-F]{1,2}$/.test(s) || /^[0-9a-fA-F]{1,2}$/.test(s) || /^\d{1,3}$/.test(s)
  return ok ? null : 'XOR 密钥为 1 字节，格式如 0x3b / 3b / 59'
}

/** AES 密钥格式校验：16 字符文本 或 32 位 hex */
function validateAes(v: string): string | null {
  if (!v.trim()) return null
  const s = v.trim()
  if (s.length === 32 && /^[0-9a-fA-F]{32}$/.test(s)) return null
  if (s.length >= 16) return null
  return 'AES 密钥为 16 字节：输入 16 字符文本或 32 位十六进制'
}

const STATUS_TEXT: Record<string, string> = {
  valid: '已验证',
  invalid: '已失效',
  pending: '待验证'
}

/** 当前账号靠哪一层密钥在工作 */
const LAYER_TEXT: Record<string, string> = {
  passphrase: '账号口令（KDF 之前，一把开全部库）',
  'db-keys': '每库派生密钥（KDF 之后，只开对应的库）',
  none: '未获取'
}

const SOURCE_TEXT: Record<string, string> = {
  registry: '注册表直读',
  import: '工具导入',
  manual: '手动粘贴'
}

function WechatKeySection(): React.JSX.Element {
  const storeWxid = useWorkbenchStore((s) => s.wxid)
  const [wxid, setWxid] = useState(storeWxid && storeWxid !== 'wxid_demo' ? storeWxid : '')
  const [accounts, setAccounts] = useState<KeyAccountInfo[]>([])
  const [dbPath, setDbPath] = useState('')
  const [keyHex, setKeyHex] = useState('')
  const [showKey, setShowKey] = useState(false)
  // 图片 .dat 解密（媒体解密接入后生效，参考 CipherTalk imageXorKey/imageAesKey）
  const [xorKey, setXorKey] = useState('')
  const [aesKey, setAesKey] = useState('')
  const [showXor, setShowXor] = useState(false)
  const [showAes, setShowAes] = useState(false)
  const [ffmpegPath, setFfmpegPath] = useState('')
  // 语音转写：腾讯云一句话识别（SILK 直传）；SecretKey 由主进程 safeStorage 加密，渲染端只提交新值
  const [tcSecretId, setTcSecretId] = useState('')
  const [tcSecretKey, setTcSecretKey] = useState('')
  const [tcRegion, setTcRegion] = useState('ap-guangzhou')
  const [tcEngine, setTcEngine] = useState('16k_zh')
  const [asrStage, setAsrStage] = useState<{
    available: boolean
    reason?: string
    hasSecretKey?: boolean
  } | null>(null)
  const [status, setStatus] = useState<KeyStatusInfo | null>(null)
  const [lastError, setLastError] = useState('')
  const [busy, setBusy] = useState<'import' | 'test' | 'connect' | 'img' | 'asr' | null>(null)

  const loadStatus = useCallback(async (id: string) => {
    if (!id.trim() || !keyStoreApi) {
      setStatus(null)
      return
    }
    const info = await keyStoreApi.getStatus(id.trim()).catch(() => null)
    setStatus(info)
    if (info?.hasKey && info.dbPath) setDbPath(info.dbPath)
    const cfg = await configApi?.getAll().catch(() => null)
    setLastError(cfg?.[`key:${id.trim()}:error`] ?? '')
    setXorKey(cfg?.[`img:${id.trim()}:xorKey`] ?? '')
    setAesKey(cfg?.[`img:${id.trim()}:aesKey`] ?? '')
    setFfmpegPath(cfg?.['media.ffmpegPath'] ?? '')
    setTcSecretId(cfg?.['asr.tencent.secretId'] ?? '')
    setTcRegion(cfg?.['asr.tencent.region'] ?? 'ap-guangzhou')
    setTcEngine(cfg?.['asr.tencent.engine'] ?? '16k_zh')
  }, [])

  // wxid 输入后自动查询密钥状态（600ms 防抖）
  useEffect(() => {
    const t = setTimeout(() => void loadStatus(wxid), 600)
    return () => clearTimeout(t)
  }, [wxid, loadStatus])

  /** 已保存密钥的账号列表（供下拉选择当前账号）；IPC 未就绪时短暂重试 */
  const loadAccounts = useCallback(async (): Promise<void> => {
    let list: KeyAccountInfo[] | null = null
    for (let i = 0; i < 5 && list === null; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1200))
      list = (await keyStoreApi?.list().catch(() => null)) ?? null
    }
    setAccounts(list ?? [])
  }, [])

  useAsyncEffect(loadAccounts, [loadAccounts])

  const browse = async (): Promise<void> => {
    const r = await dialogApi?.pickDirectory('选择微信数据根路径（db_storage 上级目录）')
    if (r?.ok && r.path) setDbPath(r.path)
  }

  const doImport = async (): Promise<void> => {
    if (!wxid.trim()) return toast.error('请先填写当前微信账号 wxid')
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex.trim())) {
      return toast.error('密钥必须是 64 位十六进制（32 字节）')
    }
    setBusy('import')
    try {
      const r = await keyStoreApi?.importKey(wxid.trim(), keyHex.trim(), 'manual', dbPath.trim())
      if (r?.success) {
        toast.success('密钥已加密保存')
        setKeyHex('')
        void loadAccounts()
        void loadStatus(wxid)
      } else {
        toast.error(r?.error || '导入失败')
      }
    } finally {
      setBusy(null)
    }
  }

  /**
   * 导入配套工具 wechat-decrypt-cli 产出的密钥文件。
   * 口令与每库派生密钥都能吃：4.1.11+ 的内存扫描只能拿到后者（口令要 hook，通常还需管理员权限），
   * 所以"整套派生密钥"也必须是可用状态，而不是逼用户去找那一把口令。
   */
  const doImportKeyFile = async (): Promise<void> => {
    if (!wxid.trim()) return toast.error('请先填写当前微信账号 wxid')
    const picked = await dialogApi?.pickFiles({
      title: '选择密钥文件（wechat-decrypt-cli 产出的 JSON）',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    const filePath = picked?.ok ? picked.paths?.[0] : ''
    if (!filePath) return
    setBusy('import')
    try {
      const r = await keyStoreApi?.importKeyFile(wxid.trim(), filePath, dbPath.trim())
      if (!r?.success) {
        toast.error(r?.error || '导入失败')
        return
      }
      const parts: string[] = []
      if (r.importedPassphrase) parts.push('账号口令（一把开全部库）')
      if (r.importedDbKeys > 0) parts.push(`每库派生密钥 ${r.importedDbKeys} 条`)
      toast.success(`已导入 ${parts.join(' + ') || '密钥'}`)
      if (r.skipped > 0) toast.error(`跳过 ${r.skipped} 条格式不合法的条目`)
      void loadAccounts()
      void loadStatus(wxid)
    } finally {
      setBusy(null)
    }
  }

  const doClearKeyRing = async (): Promise<void> => {
    if (!wxid.trim()) return
    setBusy('import')
    try {
      const removed = await keyStoreApi?.clearKeyRing(wxid.trim())
      toast.success(`已清除 ${removed ?? 0} 条每库派生密钥`)
      void loadAccounts()
      void loadStatus(wxid)
    } finally {
      setBusy(null)
    }
  }

  const doTest = async (): Promise<void> => {
    setBusy('test')
    try {
      const r = await keyStoreApi?.test(wxid.trim())
      if (r?.success) toast.success('密钥验证通过，数据库可解密')
      else toast.error(r?.error || '验证失败')
      void loadStatus(wxid)
    } finally {
      setBusy(null)
    }
  }

  const doConnect = async (): Promise<void> => {
    setBusy('connect')
    try {
      const r = await wxApi?.connect(wxid.trim())
      if (!r?.ok) {
        toast.error(r?.error || '连接失败')
        void loadStatus(wxid)
        return
      }
      await wxApi?.startWatch(wxid.trim())
      toast.success('已连接并启动实时监控')
      // 让对话页用真实账号重新加载（真实库失败时会自动降级示例数据）
      await useWorkbenchStore.getState().init(wxid.trim())
    } finally {
      setBusy(null)
    }
  }

  /** 保存图片解密密钥（app_config 按 wxid 维度存储） */
  const saveImgKeys = async (): Promise<void> => {
    if (!wxid.trim()) return toast.error('请先填写当前微信账号 wxid')
    const xorErr = validateXor(xorKey)
    if (xorErr) return toast.error(xorErr)
    const aesErr = validateAes(aesKey)
    if (aesErr) return toast.error(aesErr)
    setBusy('img')
    try {
      await configApi?.set(`img:${wxid.trim()}:xorKey`, xorKey.trim())
      await configApi?.set(`img:${wxid.trim()}:aesKey`, aesKey.trim())
      await configApi?.set('media.ffmpegPath', ffmpegPath.trim())
      toast.success('图片解密密钥已保存')
    } finally {
      setBusy(null)
    }
  }

  /**
   * 从账号目录的 *_t.dat 模板**本地推导**图片 XOR 密钥，并用模板探测段校验 AES。
   * 不依赖任何原生组件（不读内存、不调 DLL）；推导成功直接填进输入框，用户只需点保存。
   */
  const deriveImgKeys = async (): Promise<void> => {
    if (!wxid.trim()) return toast.error('请先填写当前微信账号 wxid')
    if (!keyReady) return toast.error('请先导入数据库密钥（用于定位账号目录）')
    setBusy('img')
    try {
      const r = await wxApi?.deriveImageKeys?.(wxid.trim(), aesKey.trim() || undefined)
      if (!r?.ok) {
        toast.error(r?.error || '推导失败')
        return
      }
      if (typeof r.xorKey === 'number') {
        setXorKey(`0x${r.xorKey.toString(16).toUpperCase()}`)
      }
      const parts = [
        `XOR 已推导 0x${(r.xorKey ?? 0).toString(16).toUpperCase()}`,
        `模板 ${r.templateCount ?? 0} 份/一致 ${r.xorVotes ?? 0} 份`
      ]
      if (r.aesVerified === true) parts.push('AES 校验通过')
      else if (r.aesVerified === false) parts.push(`AES 未通过校验：${r.error ?? '与模板不匹配'}`)
      toast.success(parts.join(' · '))
    } finally {
      setBusy(null)
    }
  }

  /**
   * 保存腾讯云 ASR 配置并检测一次。
   * SecretKey 只在用户输入了新值时提交，主进程用 safeStorage 加密后落库（渲染端不持有明文）。
   */
  const saveAsrConfig = async (): Promise<void> => {
    setBusy('asr')
    try {
      await Promise.all([
        configApi?.set('asr.tencent.secretId', tcSecretId.trim()),
        configApi?.set('asr.tencent.region', tcRegion.trim() || 'ap-guangzhou'),
        configApi?.set('asr.tencent.engine', tcEngine.trim() || '16k_zh')
      ])
      if (tcSecretKey.trim()) {
        const saved = await mediaApi?.asrSaveSecret?.(tcSecretKey.trim())
        if (!saved?.ok) {
          toast.error(saved?.error || 'SecretKey 保存失败')
          return
        }
        setTcSecretKey('')
      }
      const st = await mediaApi?.asrStatus?.()
      setAsrStage({
        available: st?.available === true,
        reason: st?.reason,
        hasSecretKey: st?.hasSecretKey
      })
      if (st?.available) toast.success('语音转写已就绪（腾讯云一句话识别，SILK 直传）')
      else toast.error(st?.reason || '语音转写不可用')
    } finally {
      setBusy(null)
    }
  }

  /** 测试图片密钥：先保存当前输入，再从 attach 取一张图真实解密 */
  const testImageKey = async (): Promise<void> => {
    if (!wxid.trim()) return toast.error('请先填写当前微信账号 wxid')
    if (!keyReady) return toast.error('请先导入数据库密钥（用于定位微信数据目录）')
    const xorErr = validateXor(xorKey)
    if (xorErr) return toast.error(xorErr)
    const aesErr = validateAes(aesKey)
    if (aesErr) return toast.error(aesErr)
    setBusy('img')
    try {
      await configApi?.set(`img:${wxid.trim()}:xorKey`, xorKey.trim())
      await configApi?.set(`img:${wxid.trim()}:aesKey`, aesKey.trim())
      await configApi?.set('media.ffmpegPath', ffmpegPath.trim())
      const r = await mediaApi?.testImageDecrypt(wxid.trim(), dbPath.trim() || undefined)
      if (r?.ok && r.url) toast.success(`图片密钥有效（${r.ext ?? ''}）`)
      else toast.error(r?.error || '图片解密失败')
    } finally {
      setBusy(null)
    }
  }

  const keyReady = !!status?.hasKey

  return (
    <SettingsCard title="微信数据与密钥">
      {/* 当前账号：已保存密钥的账号下拉选择；无已导入账号或手动输入其他账号时展开文本输入 */}
      {accounts.length > 0 && (
        <label className="st-row">
          <span className="st-label">当前账号</span>
          <select
            className="st-input"
            value={accounts.some((a) => a.wxid === wxid) ? wxid : '__manual__'}
            onChange={(e) => {
              const v = e.target.value
              if (v !== '__manual__') setWxid(v)
            }}
            title="选择已导入密钥的账号"
          >
            <option value="__manual__">＋ 手动输入其他账号…</option>
            {accounts.map((a) => (
              <option key={a.wxid} value={a.wxid}>
                {a.wxid}（{STATUS_TEXT[a.status ?? 'pending'] ?? a.status ?? '未知'}）
              </option>
            ))}
          </select>
        </label>
      )}

      {(accounts.length === 0 || !accounts.some((a) => a.wxid === wxid)) && (
        <label className="st-row">
          <span className="st-label">
            {accounts.length > 0 ? '账号 wxid（手动输入）' : '当前账号 wxid'}
          </span>
          <input
            className="st-input"
            value={wxid}
            onChange={(e) => setWxid(e.target.value)}
            placeholder="wxid_xxxxxxxx"
          />
        </label>
      )}

      <label className="st-row">
        <span className="st-label">微信数据根路径</span>
        <input
          className="st-input"
          value={dbPath}
          onChange={(e) => setDbPath(e.target.value)}
          placeholder="如 C:\Users\xxx\Documents\xwechat_files"
        />
        <button type="button" className="ui-btn" onClick={() => void browse()}>
          浏览…
        </button>
      </label>

      <label className="st-row">
        <span className="st-label">数据库密钥（64 位十六进制）</span>
        <input
          className="st-input"
          type={showKey ? 'text' : 'password'}
          value={keyHex}
          onChange={(e) => setKeyHex(e.target.value)}
          placeholder="外部工具导出后粘贴到此处"
        />
        <button
          type="button"
          className="ui-btn"
          onClick={() => setShowKey((v) => !v)}
          title={showKey ? '隐藏' : '显示'}
        >
          {showKey ? '隐藏' : '显示'}
        </button>
      </label>

      <div className="st-actions">
        <button
          type="button"
          className="ui-btn is-primary"
          disabled={busy !== null}
          onClick={() => void doImport()}
        >
          {busy === 'import' ? '导入中…' : '导入密钥'}
        </button>
        <button
          type="button"
          className="ui-btn"
          disabled={busy !== null}
          onClick={() => void doImportKeyFile()}
          title="导入 wechat-decrypt-cli 产出的 JSON：账号口令与每库派生密钥都可；只有派生密钥时同样能解密（按库各取各的密钥）"
        >
          {busy === 'import' ? '导入中…' : '导入密钥文件'}
        </button>
        <button
          type="button"
          className="ui-btn"
          disabled={busy !== null || !keyReady}
          onClick={() => void doTest()}
        >
          {busy === 'test' ? '验证中…' : '测试解密'}
        </button>
        <button
          type="button"
          className="ui-btn"
          disabled={busy !== null || !keyReady}
          onClick={() => void doConnect()}
        >
          {busy === 'connect' ? '连接中…' : '连接并启动监控'}
        </button>
      </div>

      {/* 语音转写：腾讯云一句话识别（SILK 直传，不需要本地模型） */}
      <div className="st-subtitle">语音转写（腾讯云 ASR）</div>
      <label className="st-row">
        <span className="st-label">SecretId</span>
        <input
          className="st-input"
          value={tcSecretId}
          onChange={(e) => setTcSecretId(e.target.value)}
          placeholder="腾讯云 → 访问管理 → API 密钥"
        />
      </label>
      <label className="st-row">
        <span className="st-label">SecretKey</span>
        <input
          className="st-input"
          type="password"
          value={tcSecretKey}
          onChange={(e) => setTcSecretKey(e.target.value)}
          placeholder={
            asrStage?.hasSecretKey ? '已保存（留空=不修改）' : '仅提交一次，主进程加密保存'
          }
        />
      </label>
      <label className="st-row">
        <span className="st-label">地域</span>
        <input
          className="st-input"
          value={tcRegion}
          onChange={(e) => setTcRegion(e.target.value)}
          placeholder="ap-guangzhou"
        />
      </label>
      <label className="st-row">
        <span className="st-label">引擎模型</span>
        <input
          className="st-input"
          value={tcEngine}
          onChange={(e) => setTcEngine(e.target.value)}
          placeholder="16k_zh（中文通用）/ 16k_zh_dialect（23 种方言）"
        />
      </label>
      <div className="st-actions">
        <button
          type="button"
          className="ui-btn is-primary"
          disabled={busy !== null}
          onClick={() => void saveAsrConfig()}
        >
          {busy === 'asr' ? '检测中…' : '保存并检测'}
        </button>
        <span className="st-hint">
          {asrStage
            ? asrStage.available
              ? '已就绪：语音气泡点「转写」即可（微信 SILK 直传，不走本地模型）'
              : asrStage.reason || '不可用'
            : '未配置也不影响语音播放；配置后转写文本会进入界面、议题分析与数字员工的判断依据'}
        </span>
      </div>

      {/* 图片 .dat 解密密钥（M3：msg/attach 内 <md5>.dat 原图与缩略图） */}
      <div className="st-subtitle">图片解密（msg/attach 内 .dat 附件）</div>
      <label className="st-row">
        <span className="st-label">XOR 密钥（1 字节）</span>
        <input
          className="st-input"
          type={showXor ? 'text' : 'password'}
          value={xorKey}
          onChange={(e) => setXorKey(e.target.value)}
          placeholder="如 0x3b / 3b / 59"
        />
        <button type="button" className="ui-btn" onClick={() => setShowXor((v) => !v)}>
          {showXor ? '隐藏' : '显示'}
        </button>
      </label>
      <label className="st-row">
        <span className="st-label">AES 密钥（16 字节文本）</span>
        <input
          className="st-input"
          type={showAes ? 'text' : 'password'}
          value={aesKey}
          onChange={(e) => setAesKey(e.target.value)}
          placeholder="16 字符文本（取前 16 字符）或 32 位十六进制"
        />
        <button type="button" className="ui-btn" onClick={() => setShowAes((v) => !v)}>
          {showAes ? '隐藏' : '显示'}
        </button>
      </label>
      <label className="st-row">
        <span className="st-label">ffmpeg 路径（HEVC 原图转码）</span>
        <input
          className="st-input"
          value={ffmpegPath}
          onChange={(e) => setFfmpegPath(e.target.value)}
          placeholder="留空则按 WECHAT_CS_FFMPEG 环境变量 / PATH 查找"
        />
      </label>

      <div className="st-actions">
        <button
          type="button"
          className="ui-btn"
          disabled={busy !== null || !keyReady}
          onClick={() => void deriveImgKeys()}
          title="读账号目录下的 *_t.dat 模板：本地推导 XOR 密钥，并用模板探测段校验 AES（不读内存、不需要额外组件）"
        >
          {busy === 'img' ? '处理中…' : '自动推导图片密钥'}
        </button>
        <button
          type="button"
          className="ui-btn is-primary"
          disabled={busy !== null}
          onClick={() => void saveImgKeys()}
        >
          {busy === 'img' ? '保存中…' : '保存图片密钥'}
        </button>
        <span className="st-hint">不同微信版本可能只需要其中一种，留空表示未配置</span>
      </div>
      <div className="st-actions">
        <button
          type="button"
          className="ui-btn"
          disabled={busy !== null}
          onClick={() => void testImageKey()}
        >
          {busy === 'img' ? '测试中…' : '测试解密一张图片'}
        </button>
        <span className="st-hint">保存后从当前账号的 msg/attach 中取一张图验证密钥</span>
      </div>

      {/* 密钥状态卡片 */}
      {wxid.trim() && (
        <div className="st-keystatus">
          {!status?.hasKey ? (
            <div className="st-kv">
              <span>密钥状态</span>
              <span className="st-bad">未导入</span>
            </div>
          ) : (
            <>
              <div className="st-kv">
                <span>密钥状态</span>
                <span className={status.status === 'valid' ? 'st-ok' : 'st-bad'}>
                  {STATUS_TEXT[status.status ?? 'pending'] ?? status.status}
                </span>
              </div>
              <div className="st-kv">
                <span>密钥层级</span>
                <span className={status.layer === 'none' ? 'st-bad' : 'st-ok'}>
                  {LAYER_TEXT[status.layer ?? 'none']}
                </span>
              </div>
              {status.keyRingSize > 0 && (
                <div className="st-kv">
                  <span>每库派生密钥</span>
                  <span className="st-ok">
                    {status.keyRingSize} 条
                    <button
                      type="button"
                      className="ui-btn"
                      style={{ marginLeft: 8 }}
                      disabled={busy !== null}
                      onClick={() => void doClearKeyRing()}
                    >
                      清除
                    </button>
                  </span>
                </div>
              )}
              <div className="st-kv">
                <span>密钥来源</span>
                <span>{SOURCE_TEXT[status.source ?? ''] ?? status.source ?? '—'}</span>
              </div>
              <div className="st-kv">
                <span>数据路径</span>
                <span className="st-path">{status.dbPath || '—'}</span>
              </div>
              {lastError && (
                <div className="st-kv">
                  <span>最近错误</span>
                  <span className="st-bad">{lastError}</span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="st-decrypt-note">
        提示：微信 4.x（xwechat）是魔改 SQLCipher（页 4096、尾部 80B 保留区放 IV 与 HMAC-SHA512、
        AES-256-CBC），标准 SQLCipher 驱动无法直开；本应用自带完整解密层 —— 解密前先用页 1 的 HMAC
        验证密钥，再逐页校验解密（能抓出微信正在写入导致的撕裂页）、合并 WAL、结构自检后原子落盘。
        <br />
        <strong>一个账号只有一把密钥</strong>：每个库文件自带独立的随机 16 字节 salt，派生出的 AES
        密钥按库各不相同，但口令是同一把 —— 所以这里粘一次即可解密该账号的全部数据库。
        <br />
        请填<strong>账号口令</strong>（KDF 之前的 64 位十六进制）。若你拿到的是某个库的
        <strong>派生密钥</strong>（KDF 之后，内存扫描常按每库一把列出），它只开得动那一个库，
        导入时会被识别并提示。取密钥请用外部工具导出后手动导入；密钥以系统级 safeStorage
        保存，主进程持有明文，渲染端只看到状态。
      </div>
    </SettingsCard>
  )
}

export default WechatKeySection
