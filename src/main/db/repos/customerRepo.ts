import { getDb } from '../database'
import {
  countCustomerProfiles as countStore,
  listCustomerProfiles as listStore,
  removeCustomerTag as removeTagStore,
  setCustomerTag as setTagStore,
  updateCustomerFields as updateFieldsStore,
  upsertCustomersFromSessions as upsertStore,
  type SessionCustomerRow,
  type UpsertResult
} from '../customerStore'
import type { CustomerStored } from '../../../shared/customerProfile'

/**
 * 客户档案仓储（把数据库单例注入给 customerStore 的 SQL 层）。
 *
 * SQL 都在 db/customerStore.ts —— 那里 db 由调用方传入，所以能被自检脚本用临时库跑真 DDL。
 * 这里只负责「拿到单例 + 转发」，别把 SQL 又写回来（写回来就没法自检了）。
 */

export type { SessionCustomerRow, UpsertResult }

export function upsertCustomersFromSessions(
  accountWxid: string,
  rows: SessionCustomerRow[]
): UpsertResult {
  return upsertStore(getDb(), accountWxid, rows)
}

export function listCustomerProfiles(accountWxid: string): Map<string, CustomerStored> {
  return listStore(getDb(), accountWxid)
}

export function setCustomerTag(
  accountWxid: string,
  username: string,
  tag: string,
  kind: 'manual' | 'derived' = 'manual'
): void {
  setTagStore(getDb(), accountWxid, username, tag, kind)
}

export function removeCustomerTag(accountWxid: string, username: string, tag: string): number {
  return removeTagStore(getDb(), accountWxid, username, tag)
}

export function updateCustomerFields(
  accountWxid: string,
  username: string,
  patch: { source?: string; note?: string }
): boolean {
  return updateFieldsStore(getDb(), accountWxid, username, patch)
}

export function countCustomerProfiles(accountWxid: string): number {
  return countStore(getDb(), accountWxid)
}
