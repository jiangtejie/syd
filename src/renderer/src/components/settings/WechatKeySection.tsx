import { useCallback, useEffect, useState } from 'react'
import { useWorkbenchStore } from '../../stores/workbench'
import { toast } from '../../stores/toast'
import { SettingsCard } from './ui'
import type { KeyAccountInfo, KeyStatusInfo } from '../../../../shared/types'

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
  // 本地语音转写（whisper.cpp 外部可执行文件 + 本地模型）：与 ffmpeg 同一套「外部工具」思路
  const [asrWhisper, setAsrWhisper] = useState('')
  const [asrModel, setAsrModel] = useState('')
  const [asrLang, setAsrLang] = useState('zh')
  const [asrStatus, setAsrStatus] = useState<{ available: boolean; reason?: string } | null>(null)
  // 密钥自动获取的三个来源：外部工具命令 + 本地搜索路径（可选组件走固定目录，无需配置）
  const [keyToolCmd, setKeyToolCmd] = useState('')
  const [keyToolArgs, setKeyToolArgs] = useState('')
  const [keySearchPaths, setKeySearchPaths] = useState('')
  const [scanAttempts, setScanAttempts] = useState<
    Array<{ label: string; status: string; detail: string }>
  >([])
  const [status, setStatus] = useState<KeyStatusInfo | null>(null)
  const [lastError, setLastError] = useState('')
  const [busy, setBusy] = useState<'import' | 'test' | 'connect' | 'img' | 'scan' | 'asr' | null>(
    null
  )

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
    setAsrWhisper(cfg?.['asr.whisperPath'] ?? '')
    setAsrModel(cfg?.['asr.modelPath'] ?? '')
    setAsrLang(cfg?.['asr.language'] ?? 'zh')
    setKeyToolCmd(cfg?.['wechat.keyTool.command'] ?? '')
    setKeyToolArgs(cfg?.['wechat.keyTool.args'] ?? '')
    setKeySearchPaths(cfg?.['wechat.keySearchPaths'] ?? '')
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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载异步拉取账号列表(全仓同款模式)
    void loadAccounts()
  }, [loadAccounts])

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
   * 库密钥自动获取：走可选的「密钥扫描组件」（本应用不随包分发）。
   * 组件没装是**预期状态**——这里不报错，而是把「怎么装 / 怎么退回手填」说清楚；
   * 组件给出候选 key 也必须先过页 1 校验才会落库（校验在主进程）。
   */
  const scanDbKey = async (): Promise<void> => {
    if (!wxid.trim()) return toast.error('请先填写当前微信账号 wxid')
    setBusy('scan')
    setScanAttempts([])
    try {
      // 先把配置落库再扫描：改了外部工具/搜索路径要即时生效
      await Promise.all([
        configApi?.set('wechat.keyTool.command', keyToolCmd.trim()),
        configApi?.set('wechat.keyTool.args', keyToolArgs.trim()),
        configApi?.set('wechat.keySearchPaths', keySearchPaths.trim())
      ])
      const r = await wxApi?.scanDbKey?.(wxid.trim())
      setScanAttempts(r?.attempts ?? [])
      if (r?.ok) {
        const label =
          r.provider === 'externalTool'
            ? '外部工具'
            : r.provider === 'localArtifacts'
              ? '本地文件'
              : '可选组件'
        toast.success(
          `密钥已自动获取并导入（来源：${label}）` +
            (r.valid === false ? '；测试未通过，请检查数据目录' : '')
        )
        await loadStatus(wxid.trim())
        return
      }
      toast.error(r?.error || '自动获取失败')
    } finally {
      setBusy(null)
    }
  }

  /** 保存语音转写配置并即时探测一次（whisper/模型是否存在） */
  const saveAsr = async (): Promise<void> => {
    setBusy('asr')
    try {
      await Promise.all([
        configApi?.set('asr.whisperPath', asrWhisper.trim()),
        configApi?.set('asr.modelPath', asrModel.trim()),
        configApi?.set('asr.language', asrLang.trim() || 'zh')
      ])
      const st = await mediaApi?.asrStatus?.()
      setAsrStatus({ available: st?.available === true, reason: st?.reason })
      if (st?.available) toast.success('语音转写已就绪（本地 whisper，离线）')
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
        <button type="button" className="st-btn ghost" onClick={() => void browse()}>
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
          className="st-btn ghost"
          onClick={() => setShowKey((v) => !v)}
          title={showKey ? '隐藏' : '显示'}
        >
          {showKey ? '隐藏' : '显示'}
        </button>
      </label>

      <div className="st-actions">
        <button
          type="button"
          className="st-btn"
          disabled={busy !== null}
          onClick={() => void doImport()}
        >
          {busy === 'import' ? '导入中…' : '导入密钥'}
        </button>
        <button
          type="button"
          className="st-btn ghost"
          disabled={busy !== null}
          onClick={() => void scanDbKey()}
          title="依次尝试三个来源：可选组件 → 外部工具 → 本地文件；候选必须通过页 1 HMAC 校验才会导入"
        >
          {busy === 'scan' ? '尝试中…' : '自动获取密钥'}
        </button>
        <button
          type="button"
          className="st-btn ghost"
          disabled={busy !== null || !keyReady}
          onClick={() => void doTest()}
        >
          {busy === 'test' ? '验证中…' : '测试解密'}
        </button>
        <button
          type="button"
          className="st-btn ghost"
          disabled={busy !== null || !keyReady}
          onClick={() => void doConnect()}
        >
          {busy === 'connect' ? '连接中…' : '连接并启动监控'}
        </button>
      </div>

      {/* 密钥自动获取的三个来源：可选组件（固定目录）· 外部工具 · 本地已导出的密钥文件 */}
      <div className="st-subtitle">密钥自动获取的来源（可选）</div>
      <label className="st-row">
        <span className="st-label">外部工具命令</span>
        <input
          className="st-input"
          value={keyToolCmd}
          onChange={(e) => setKeyToolCmd(e.target.value)}
          placeholder="如 D:\tools\dump-key.exe（输出里含 64 位十六进制即可）"
        />
      </label>
      <label className="st-row">
        <span className="st-label">外部工具参数</span>
        <input
          className="st-input"
          value={keyToolArgs}
          onChange={(e) => setKeyToolArgs(e.target.value)}
          placeholder="支持 {{wxid}} / {{dbPath}} / {{dbStorage}}，如 --wxid {{wxid}}"
        />
      </label>
      <label className="st-row">
        <span className="st-label">密钥搜索路径</span>
        <input
          className="st-input"
          value={keySearchPaths}
          onChange={(e) => setKeySearchPaths(e.target.value)}
          placeholder="留空=应用数据目录 + 微信数据根；多个路径用 ; 分隔"
        />
      </label>
      {scanAttempts.length > 0 && (
        <div className="st-hint">
          {scanAttempts.map((a) => (
            <div key={a.label}>
              {a.status === 'ok' ? '✅' : a.status === 'skipped' ? '➖' : '⚠️'} {a.label}：
              {a.detail}
            </div>
          ))}
        </div>
      )}

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
        <button type="button" className="st-btn ghost" onClick={() => setShowXor((v) => !v)}>
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
        <button type="button" className="st-btn ghost" onClick={() => setShowAes((v) => !v)}>
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
      {/* 本地语音转写：外部 whisper 可执行文件 + 本地模型，全程离线（不内置模型，避免安装包膨胀） */}
      <div className="st-subtitle">语音转写（本地 whisper.cpp，离线）</div>
      <label className="st-row">
        <span className="st-label">whisper 可执行文件</span>
        <input
          className="st-input"
          value={asrWhisper}
          onChange={(e) => setAsrWhisper(e.target.value)}
          placeholder="如 D:\whisper\whisper-cli.exe（留空=不转写）"
        />
      </label>
      <label className="st-row">
        <span className="st-label">模型文件（ggml-*.bin）</span>
        <input
          className="st-input"
          value={asrModel}
          onChange={(e) => setAsrModel(e.target.value)}
          placeholder="如 D:\whisper\ggml-medium.bin"
        />
      </label>
      <label className="st-row">
        <span className="st-label">语言</span>
        <input
          className="st-input"
          value={asrLang}
          onChange={(e) => setAsrLang(e.target.value)}
          placeholder="zh（留空=自动判定）"
        />
      </label>
      <div className="st-actions">
        <button
          type="button"
          className="st-btn"
          disabled={busy !== null}
          onClick={() => void saveAsr()}
        >
          {busy === 'asr' ? '检测中…' : '保存并检测'}
        </button>
        <span className="st-hint">
          {asrStatus
            ? asrStatus.available
              ? '已就绪：语音气泡点「转写」即可（24kHz→16kHz 由应用内重采样）'
              : asrStatus.reason || '不可用'
            : '不配置也不影响语音播放；转写结果会缓存并进入议题分析与数字员工的判断依据'}
        </span>
      </div>

      <div className="st-actions">
        <button
          type="button"
          className="st-btn ghost"
          disabled={busy !== null || !keyReady}
          onClick={() => void deriveImgKeys()}
          title="读账号目录下的 *_t.dat 模板：本地推导 XOR 密钥，并用模板探测段校验 AES（不读内存、不需要额外组件）"
        >
          {busy === 'img' ? '处理中…' : '自动推导图片密钥'}
        </button>
        <button
          type="button"
          className="st-btn"
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
          className="st-btn ghost"
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
        提示：微信 4.x（xwechat）数据库为魔改 SQLCipher（每库独立密钥 + 自定义页格式），
        标准解密驱动无法直开。当前解密层处于预留状态，「测试解密」在未接入自研解密前可能失败，
        工作台会自动降级为示例数据。取 key 请使用外部工具导出后手动导入。
      </div>
    </SettingsCard>
  )
}

export default WechatKeySection
