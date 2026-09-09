import { getConfig, getConfigBoolean, setConfig } from '../../db/repos/config'
import { openSecret, sealSecret } from '../secrets'

/**
 * growth 域运行配置(app_config 键空间 growth.*)。
 * growth.providerApiKey 为敏感值: 落库前 safeStorage 加封(enc1:), 读取时开封。
 */

export interface GrowthConfig {
  autoEnabled: boolean
  provider: string
  /** 主进程内解密后的明文 Key(不落盘) */
  apiKey: string
}

export function getGrowthConfig(): GrowthConfig {
  return {
    autoEnabled: getConfigBoolean('growth.enabled', false),
    provider: (getConfig('growth.provider') ?? '').trim(),
    apiKey: openSecret(getConfig('growth.providerApiKey'))
  }
}

export function setGrowthConfigField(
  field: 'autoEnabled' | 'provider' | 'providerApiKey',
  value: string
): void {
  if (field === 'autoEnabled') {
    setConfig('growth.enabled', value === 'true' || value === '1' ? '1' : '0')
    return
  }
  if (field === 'provider') {
    setConfig('growth.provider', (value ?? '').trim().slice(0, 64))
    return
  }
  setConfig('growth.providerApiKey', sealSecret(value ?? ''))
}
