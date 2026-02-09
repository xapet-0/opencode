import puppeteer from "puppeteer-core"
import { Config } from "../config/config"
import { Log } from "../util/log"

export namespace Browser {
  const log = Log.create({ service: "browser" })

  export function normalize(data: unknown) {
    return normalizeCookies(data)
  }

  export async function connect(input?: {
    url?: string
    ws?: string
    access_token?: string
    auth_header?: string
    headers?: Record<string, string>
    cookies?: Cookie[]
    cookies_file?: string
  }) {
    const config = await Config.get()
    const url = input?.url ?? config.browser?.url
    const ws = input?.ws ?? config.browser?.ws
    const token = input?.access_token ?? config.browser?.access_token
    const header = input?.auth_header ?? config.browser?.auth_header ?? "Authorization"
    const headers = mergeHeaders(config.browser?.headers, input?.headers)
    const cookies = mergeCookies(config.browser?.cookies, input?.cookies)
    const cookieFile = input?.cookies_file ?? config.browser?.cookies_file
    const target = resolveTarget(url, ws)
    if (!target.ok) return target

    const first = await attempt(target.options, headers, cookies, cookieFile)
    if (first.ok) return first

    if (!token) return first
    if (headers?.[header]) return first

    log.info("retrying browser connection with auth header")
    return attempt(
      target.options,
      mergeHeaders(headers, { [header]: `Bearer ${token}` }),
      cookies,
      cookieFile,
    )
  }
}

type Cookie = {
  name: string
  value: string
  domain?: string
  path?: string
  url?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: "Strict" | "Lax" | "None"
}

function normalizeCookies(data: unknown): Cookie[] {
  if (!data) return []
  if (Array.isArray(data)) {
    return data.flatMap((item) => {
      const cookie = normalizeCookie(item)
      return cookie ? [cookie] : []
    })
  }
  if (typeof data === "object" && data && "cookies" in data) {
    return normalizeCookies((data as { cookies?: unknown }).cookies)
  }
  return []
}

function normalizeCookie(item: unknown): Cookie | undefined {
  if (!item || typeof item !== "object") return undefined
  const data = item as Record<string, unknown>
  const name = typeof data.name === "string" ? data.name : undefined
  const raw = data.value
  const value = typeof raw === "string" ? raw : raw === undefined || raw === null ? undefined : String(raw)
  if (!name || value === undefined) return undefined

  const cookie: Cookie = { name, value }
  if (typeof data.domain === "string") cookie.domain = data.domain
  if (typeof data.url === "string") cookie.url = data.url
  if (typeof data.path === "string") cookie.path = data.path
  if (typeof data.httpOnly === "boolean") cookie.httpOnly = data.httpOnly
  if (typeof data.secure === "boolean") cookie.secure = data.secure

  const same = normalizeSameSite(data.sameSite)
  if (same) cookie.sameSite = same

  const expires = normalizeNumber(
    data.expires ?? data.expirationDate ?? data.expiry ?? data.expiresAt ?? data.expire,
  )
  if (expires !== undefined) cookie.expires = expires

  return cookie
}

function normalizeNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return undefined
  return parsed
}

function normalizeSameSite(value: unknown): Cookie["sameSite"] {
  if (typeof value !== "string") return undefined
  const lower = value.toLowerCase()
  if (lower === "strict") return "Strict"
  if (lower === "lax") return "Lax"
  if (lower === "none" || lower === "no_restriction") return "None"
  return undefined
}

function resolveTarget(url?: string, ws?: string) {
  if (ws) return { ok: true as const, options: { browserWSEndpoint: ws } }
  if (url) return { ok: true as const, options: { browserURL: url } }
  return { ok: false as const, error: new Error("Browser URL is not configured") }
}

function mergeHeaders(base?: Record<string, string>, extra?: Record<string, string>) {
  if (!base && !extra) return undefined
  return {
    ...(base ?? {}),
    ...(extra ?? {}),
  }
}

function mergeCookies(base?: Cookie[], extra?: Cookie[]) {
  if (!base && !extra) return undefined
  return [...(base ?? []), ...(extra ?? [])]
}

async function loadCookies(file?: string) {
  if (!file) return undefined
  const data = await Bun.file(file).json().catch(() => undefined)
  const cookies = normalizeCookies(data)
  return cookies.length ? cookies : undefined
}

async function applyCookies(browser: Awaited<ReturnType<typeof puppeteer.connect>>, cookies?: Cookie[]) {
  if (!cookies || cookies.length === 0) return
  await browser.defaultBrowserContext().setCookie(...cookies)
}

async function attempt(
  options: { browserURL?: string; browserWSEndpoint?: string },
  headers?: Record<string, string>,
  cookies?: Cookie[],
  file?: string,
) {
  return puppeteer.connect({ ...options, headers }).then(
    async (browser) => {
      const fileCookies = await loadCookies(file)
      const merged = mergeCookies(cookies, fileCookies)
      await applyCookies(browser, merged)
      return { ok: true as const, browser }
    },
    (error) => ({ ok: false as const, error }),
  )
}
