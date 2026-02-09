import puppeteer from "puppeteer-core"
import { Config } from "../config/config"
import { Log } from "../util/log"

export namespace Browser {
  const log = Log.create({ service: "browser" })

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

function isCookie(input: unknown): input is Cookie {
  if (!input || typeof input !== "object") return false
  if (!("name" in input) || !("value" in input)) return false
  return typeof (input as { name?: unknown }).name === "string" && typeof (input as { value?: unknown }).value === "string"
}

async function loadCookies(file?: string) {
  if (!file) return undefined
  const data = await Bun.file(file)
    .json()
    .catch(() => undefined)
  if (!Array.isArray(data)) return undefined
  const filtered = data.filter(isCookie)
  return filtered.length ? filtered : undefined
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
