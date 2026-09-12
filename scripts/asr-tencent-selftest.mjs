#!/usr/bin/env node
/**
 * 腾讯云 ASR（一句话识别）接入的纯逻辑自检（离线，不需要密钥、不发请求）：
 *   node scripts/asr-tencent-selftest.mjs
 *
 * 覆盖三件「错了很难查」的事：
 * 1. TC3-HMAC-SHA256 签名 —— 用**腾讯官方 Node SDK（sign3）生成的黄金向量**做已知答案测试
 *    （本仓实现与官方 SDK 同输入必须同输出；SignedHeaders 取 content-type;host，与 SDK 一致）；
 * 2. 一句话识别请求体 —— 字段名/取值（EngSerViceType/SourceType=1/VoiceFormat/DataLen=base64 前长度），
 *    以及官方明确要求的「Data 不得带换行」；
 * 3. 响应解析 —— 成功取 Result；失败把 Error.Code/Message 带出来；非法 JSON 不抛异常。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = mkdtempSync(join(tmpdir(), 'dsh-asr-tc-'))
const bundle = join(bundleDir, 'asrTencentPure.cjs')
buildSync({
  entryPoints: [join(root, 'src/main/services/media/asrTencentPure.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle
})
const {
  tc3Authorization,
  canonicalRequest,
  stringToSign,
  utcDate,
  buildSentenceRecognitionBody,
  parseSentenceRecognitionResponse,
  ASR_VOICE_FORMATS,
  ASR_CHINESE_ENGINES
} = require(bundle)

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

// —— 黄金向量：由官方 SDK 的 sign3 生成（见提交说明；同输入必须同输出）——
const GOLDEN = [
  {
    name: '一句话识别 silk',
    input: {
      secretId: 'AKIDzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
      secretKey: 'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk',
      service: 'asr',
      host: 'asr.tencentcloudapi.com',
      action: 'SentenceRecognition',
      version: '2019-06-14',
      region: 'ap-guangzhou',
      timestamp: 1789200000,
      payload: JSON.stringify({
        ProjectId: 0,
        SubServiceType: 2,
        EngSerViceType: '16k_zh',
        SourceType: 1,
        VoiceFormat: 'silk',
        Data: 'dGVzdA==',
        DataLen: 4,
        WordInfo: 0
      })
    },
    expected:
      'TC3-HMAC-SHA256 Credential=AKIDzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/2026-09-12/asr/tc3_request, SignedHeaders=content-type;host, Signature=8e36d8f445725af2b3370845916017fd9a93060b2dfc100d20aa7304541c58c7'
  },
  {
    name: 'cvm（官方文档示例体）',
    input: {
      secretId: 'AKIDz8krbsJ5yKBZQpn74WFkmLPx3EXAMPLE',
      secretKey: 'Gu5t9xGARNpq86cd98joQYCN3EXAMPLE',
      service: 'cvm',
      host: 'cvm.tencentcloudapi.com',
      action: 'DescribeInstances',
      version: '2017-03-12',
      region: 'ap-guangzhou',
      timestamp: 1551113065,
      payload: '{"Limit": 1, "Filters": [{"Values": ["未命名"], "Name": "instance-name"}]}'
    },
    expected:
      'TC3-HMAC-SHA256 Credential=AKIDz8krbsJ5yKBZQpn74WFkmLPx3EXAMPLE/2019-02-25/cvm/tc3_request, SignedHeaders=content-type;host, Signature=57ed31a395c63c472410096cc67e56aa39aa2b06b960d4f31beea21236106ca9'
  }
]

// 1) 签名：与官方 SDK 的黄金向量逐字符比对
for (const v of GOLDEN) {
  const got = tc3Authorization(v.input)
  log(got === v.expected, `签名与官方 SDK 一致：${v.name}`, got === v.expected ? undefined : got)
}
{
  const { canonical } = canonicalRequest(GOLDEN[0].input)
  log(
    canonical.startsWith('POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:asr.tencentcloudapi.com\n\ncontent-type;host\n'),
    '规范请求串结构正确（POST/空查询串/签两个头）'
  )
  log(utcDate(1551113065) === '2019-02-25', 'UTC 日期换算正确（跨时区不会签错）', utcDate(1551113065))
  log(
    stringToSign(GOLDEN[0].input).startsWith('TC3-HMAC-SHA256\n1789200000\n2026-09-12/asr/tc3_request\n'),
    '待签串结构正确（算法/时间戳/日期·服务·tc3_request）'
  )
}

// 2) 请求体
{
  const body = JSON.parse(
    buildSentenceRecognitionBody({
      data: 'AAAB\nAAAC',
      dataLen: 6,
      engine: '16k_zh',
      voiceFormat: 'silk'
    })
  )
  log(body.EngSerViceType === '16k_zh', '引擎字段正确')
  log(body.SourceType === 1, 'SourceType=1（body 上传）')
  log(body.VoiceFormat === 'silk', '语音格式 silk（微信语音原生格式，免解码）')
  log(body.SubServiceType === 2, 'SubServiceType=2（一句话识别）')
  log(body.DataLen === 6, 'DataLen 是 base64 之前的字节数（官方要求）', String(body.DataLen))
  log(!String(body.Data).includes('\n'), 'Data 里没有换行（官方明确要求）')
  log(body.ProjectId === 0 && body.WordInfo === 0, '可选字段给了默认值')
  const withFilters = JSON.parse(
    buildSentenceRecognitionBody({
      data: 'AA==',
      dataLen: 1,
      engine: '16k_zh',
      voiceFormat: 'wav',
      filterDirty: 2,
      filterModal: 1,
      hotwordId: 'hw-1'
    })
  )
  log(withFilters.FilterDirty === 2 && withFilters.FilterModal === 1 && withFilters.HotwordId === 'hw-1', '可选过滤/热词参数按需带上')
  log(ASR_VOICE_FORMATS.includes('silk') && ASR_VOICE_FORMATS.includes('amr'), '格式白名单来自官方文档')
  log(ASR_CHINESE_ENGINES.includes('16k_zh_dialect'), '引擎白名单包含中文方言引擎')
}

// 3) 响应解析
{
  const okResp = parseSentenceRecognitionResponse(
    JSON.stringify({ Response: { Result: '  物流今天能发出来吗  ', AudioDuration: 2800, RequestId: 'req-1' } })
  )
  log(okResp.ok && okResp.text === '物流今天能发出来吗', '成功响应取 Result 并去空白', JSON.stringify(okResp))
  log(okResp.audioDurationMs === 2800 && okResp.requestId === 'req-1', '音频时长与 RequestId 带出')

  const errResp = parseSentenceRecognitionResponse(
    JSON.stringify({ Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: '签名错误' }, RequestId: 'req-2' } })
  )
  log(!errResp.ok && errResp.errorCode === 'AuthFailure.SignatureFailure', '失败响应带出错误码', JSON.stringify(errResp))
  log((errResp.error ?? '').includes('签名错误'), '错误信息可读')

  const empty = parseSentenceRecognitionResponse(JSON.stringify({ Response: { Result: '' } }))
  log(empty.ok && empty.text === '', '识别为空串时不报错（调用方据此判「没听清」）')

  log(!parseSentenceRecognitionResponse('not-json').ok, '非法 JSON 不抛异常')
  log(!parseSentenceRecognitionResponse('{}').ok, '缺少 Response 字段判失败')
}

rmSync(bundleDir, { recursive: true, force: true })
console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
