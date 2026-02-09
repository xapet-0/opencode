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
    timeout_ms?: number
    goto_timeout_ms?: number
  }) {
    console.log("🚀 Browser.connect: start")
    const config = await Config.get()
    const url = input?.url ?? config.browser?.url
    const ws = input?.ws ?? config.browser?.ws
    const token = input?.access_token ?? config.browser?.access_token
    const header = input?.auth_header ?? config.browser?.auth_header ?? "Authorization"
    const headers = mergeHeaders(config.browser?.headers, input?.headers)
    const cookies = mergeCookies(config.browser?.cookies, input?.cookies)
    const cookieFile = input?.cookies_file ?? config.browser?.cookies_file
    const timeout = input?.timeout_ms ?? 10_000
    const gotoTimeout = input?.goto_timeout_ms ?? 10_000
    const target = resolveTarget(url, ws)
    if (!target.ok) {
      console.log("❌ Browser.connect: missing target")
      return target
    }

    console.log("⏳ Browser.connect: attempting connection", target.options)
    const first = await attempt(target.options, headers, cookies, cookieFile, timeout, gotoTimeout)
    if (first.ok) {
      console.log("✅ Browser.connect: connected")
      return first
    }

    if (!token) {
      console.log("❌ Browser.connect: no token available for retry")
      return first
    }
    if (headers?.[header]) {
      console.log("❌ Browser.connect: auth header already set, skipping retry")
      return first
    }

    console.log("⏳ Browser.connect: retrying with auth header")
    return attempt(
      target.options,
      mergeHeaders(headers, { [header]: `Bearer ${token}` }),
      cookies,
      cookieFile,
      timeout,
      gotoTimeout,
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
  console.log("⏳ Browser.connect: loading cookies file", file)
  const data = await Bun.file(file).json().catch(() => undefined)
  const cookies = normalizeCookies(data)
  console.log("✅ Browser.connect: cookies loaded", { count: cookies.length })
  return cookies.length ? cookies : undefined
}

function uniqueOrigins(cookies: Cookie[]) {
  const origins = new Set<string>()
  for (const cookie of cookies) {
    if (cookie.url && URL.canParse(cookie.url)) {
      const parsed = new URL(cookie.url)
      origins.add(parsed.origin)
      continue
    }
    const domain = cookie.domain?.replace(/^\./, "")
    if (!domain) continue
    origins.add(`https://${domain}`)
  }
  return Array.from(origins)
}

function withTimeout<T>(label: string, promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`))
    }, ms)
  })
  return Promise.race([promise, timeout]).then((result) => {
    if (timer) clearTimeout(timer)
    return result
  })
}

async function applyCookies(
  browser: Awaited<ReturnType<typeof puppeteer.connect>>,
  cookies?: Cookie[],
  gotoTimeout?: number,
) {
  if (!cookies || cookies.length === 0) return
  console.log("⏳ Browser.connect: applying cookies", { count: cookies.length })
  const page = await browser.newPage()
  const origins = uniqueOrigins(cookies)
  for (const origin of origins) {
    console.log("⏳ Browser.connect: navigating before cookies", origin)
    await withTimeout("page.goto", page.goto(origin, { waitUntil: "domcontentloaded" }), gotoTimeout ?? 10_000)
    const host = new URL(origin).hostname
    const scoped = cookies.flatMap((cookie) => {
      if (cookie.url) return [cookie]
      const domain = cookie.domain?.replace(/^\./, "")
      if (!domain) return []
      if (domain !== host) return []
      return [{ ...cookie, url: origin }]
    })
    if (scoped.length === 0) continue
    console.log("⏳ Browser.connect: setting cookies", { origin, count: scoped.length })
    await page.setCookie(...scoped)
  }
  await page.close()
  console.log("✅ Browser.connect: cookies applied")
}

async function attempt(
  options: { browserURL?: string; browserWSEndpoint?: string },
  headers?: Record<string, string>,
  cookies?: Cookie[],
  file?: string,
  timeout?: number,
  gotoTimeout?: number,
) {
  console.log("⏳ Browser.connect: puppeteer.connect")
  return withTimeout("puppeteer.connect", puppeteer.connect({ ...options, headers }), timeout ?? 10_000).then(
    async (browser) => {
      console.log("✅ Browser.connect: puppeteer connected")
      const fileCookies = await loadCookies(file)
      const merged = mergeCookies(cookies, fileCookies)
      await applyCookies(browser, merged, gotoTimeout)
      return { ok: true as const, browser }
    },
    (error) => {
      console.log("❌ Browser.connect: connection failed", error)
      log.error("browser connect failed", { error })
      return { ok: false as const, error }
    },
  )
}
