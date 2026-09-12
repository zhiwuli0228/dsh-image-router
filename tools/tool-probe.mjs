/**
 * One-off diagnostic plugin: fetch `describe_image` from the live tool registry
 * and execute it against a real file, proving the whole call path.
 *
 * This file is a development tool for dsh-vision-router, not part of the plugin.
 */
import { appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'tool-probe'

/** Paths are derived from this file, so the probe runs from any checkout. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPORT = join(ROOT, 'probe-report.log')

/** The session workspace the probe resolves the image inside. */
const CWD = process.cwd()

const say = (line) => {
	try {
		appendFileSync(REPORT, `${line}\n`)
	} catch {
		/* ignore */
	}
}

export function apply(ctx) {
	ctx.inject(['tools'], (toolsCtx) => {
		setTimeout(async () => {
			say(`--- tool probe at ${new Date().toISOString()} ---`)
			try {
				const tools = toolsCtx.get('tools')
				let definition
				try {
					definition = tools.get('describe_image')
				} catch (error) {
					say(`tools.get threw: ${error?.message}`)
				}
				say(`describe_image in registry: ${definition === undefined ? 'MISSING' : 'found'}`)
				if (definition === undefined) return
				say(`parameters: ${JSON.stringify(definition.parameters)}`)
				const agent = { session: { header: { id: 'probe-tool-session', cwd: CWD } } }
				const signal = new AbortController().signal
				try {
					const text = await definition.execute({ file_path: 'dsh-vision-router/probe.png' }, { signal, agent })
					say(`execute ok, ${text.length} chars:`)
					say(text.slice(0, 600))
				} catch (error) {
					say(`execute FAILED: ${error?.stack ?? String(error)}`)
				}
				say('--- tool probe done ---')
			} catch (error) {
				say(`probe threw: ${error?.stack ?? String(error)}`)
			}
		}, 9000)
	})
}
