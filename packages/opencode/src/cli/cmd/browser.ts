import { cmd } from "./cmd"
import { Browser } from "../../browser"

export const BrowserCommand = cmd({
  command: "browser",
  describe: "browser utilities",
  builder: (yargs) => yargs.command(CookieCommand).demandCommand(),
  async handler() {},
})

const CookieCommand = cmd({
  command: "cookies <input> [output]",
  describe: "normalize a cookie export into the opencode format",
  builder: (yargs) =>
    yargs
      .positional("input", {
        type: "string",
        describe: "path to cookie export JSON",
        demandOption: true,
      })
      .positional("output", {
        type: "string",
        describe: "optional output path (defaults to stdout)",
      }),
  async handler(args) {
    const data = await Bun.file(args.input).json().catch(() => undefined)
    if (!data) {
      console.error("Failed to read cookies file.")
      return
    }

    const cookies = Browser.normalize(data)
    if (!cookies.length) {
      console.error("No cookies found to write.")
      return
    }

    const json = JSON.stringify(cookies, null, 2)
    if (args.output) {
      await Bun.write(args.output, json)
      console.log(`Wrote ${cookies.length} cookies to ${args.output}`)
      return
    }

    console.log(json)
  },
})
