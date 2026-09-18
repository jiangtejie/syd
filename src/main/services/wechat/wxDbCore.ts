import { locateWeChatDbs } from './dbLocator'
import { openWxDbFile } from './decrypt'
import type { WxConnectInfo } from '../../../shared/types'

/**
 * 微信连接校验（T4）。
 * 用已解密 key 校验连接：定位库 + 尝试打开 session 库。
 */

export interface OpenWxDbResult {
  ok: boolean
  error?: string
}

/**
 * @param keyFor 可选：按文件取密钥（密钥环场景）。不传则用 hexKey（账号口令）。
 *   用回调而不是直接依赖 keyStoreService，是为了避免
 *   keyStoreService → wxDb → wxDbCore → keyStoreService 的循环导入。
 */
export function testWxConnection(
  dbPath: string,
  wxid: string,
  hexKey: string,
  keyFor?: (filePath: string) => string
): { ok: boolean; info?: WxConnectInfo; error?: string } {
  const keyOf = keyFor ?? ((_filePath: string) => hexKey)
  const paths = locateWeChatDbs(dbPath, wxid)
  if (!paths.dbStoragePath) {
    return { ok: false, error: '未找到微信数据目录（db_storage），请检查微信根路径配置' }
  }
  if (paths.sessionDbFile) {
    const opened = openWxDbFile(paths.sessionDbFile, keyOf(paths.sessionDbFile))
    if (!opened.db) return { ok: false, error: opened.error }
    opened.db.close()
  } else if (paths.msgDbFiles.length === 0) {
    return { ok: false, error: '微信数据目录下未找到任何库文件（session.db / msg_*.db）' }
  } else {
    // 无 session.db 时尝试打开任一消息库验证 key
    const opened = openWxDbFile(paths.msgDbFiles[0], keyOf(paths.msgDbFiles[0]))
    if (!opened.db) return { ok: false, error: opened.error }
    opened.db.close()
  }
  return {
    ok: true,
    info: {
      connected: true,
      dbStoragePath: paths.dbStoragePath,
      sessionDbPath: paths.sessionDbFile,
      msgDbCount: paths.msgDbFiles.length
    }
  }
}
