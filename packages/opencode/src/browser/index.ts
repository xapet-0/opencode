import puppeteer from "puppeteer-core"
import { Config } from "../config/config"
import { Log } from "../util/log"

export namespace Browser {
  const log = Log.create({ service: "browser" })

  export async function connect() {
    const config = await Config.get()
    const url = config.browser?.url
    if (!url) {
      return { ok: false, error: new Error("Browser URL is not configured") }
    }

    const first = await attempt(url)
    if (first.ok) return first

    const token = config.browser?.access_token
    if (!token) return first

    log.info("retrying browser connection with auth header")
    return attempt(url, { Authorization: `Bearer ${token}` })
  }
}

async function attempt(url: string, headers?: Record<string, string>) {
  return puppeteer.connect({ browserURL: url, headers }).then(
    (browser) => ({ ok: true as const, browser }),
    (error) => ({ ok: false as const, error }),
  )
}
