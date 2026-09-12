/**
 * Two-phase diagnostic plugin: compare the agent-resolution shapes for a fresh
 * session and for a session that was persisted and resumed by a later process.
 *
 * This file is a development tool for dsh-vision-router, not part of the plugin.
 */
import { appendFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'router-call-probe'

/** Paths are derived from this file, so the probe runs from any checkout. */
const REPORT = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'probe-report.log')

/** The session workspace the probe creates its session in. */
const CWD = process.cwd()
const SESSION = 'probe-vision-router'

const say = (line) => {
	try {
		appendFileSync(REPORT, `${line}\n`)
	} catch {
		/* ignore */
	}
}

/** Describe a resolveAgent() result without assuming its shape. */
function describe(value) {
	if (value === undefined) return 'undefined'
	if (value === null) return 'null'
	const kind = value.constructor?.name ?? typeof value
	const keys = Object.keys(value).slice(0, 6).join(',')
	return `${kind}{${keys}} agent=${value.agent === undefined ? 'undefined' : (value.agent?.constructor?.name ?? typeof value.agent)} session=${value.session === undefined ? 'undefined' : 'present'}`
}

export function apply(ctx) {
	ctx.inject(['sessionController'], (sessionCtx) => {
		setTimeout(async () => {
			const phase = existsSync(REPORT) ? 'B(resumed)' : 'A(fresh)'
			say(`--- call probe phase ${phase} at ${new Date().toISOString()} ---`)
			try {
				const controller = sessionCtx.sessionController
				const inner = controller.agents

				say(`facade.resolveAgent -> ${describe(await controller.resolveAgent(SESSION))}`)
				try {
					say(`inner.resolveAgent  -> ${describe(await inner.resolveAgent(SESSION))}`)
				} catch (error) {
					say(`inner.resolveAgent threw: ${error?.message}`)
				}
				try {
					say(`inner.ensureSession -> ${describe(await inner.ensureSession(SESSION, CWD, false))}`)
				} catch (error) {
					say(`inner.ensureSession threw: ${error?.message}`)
				}

				for (const [label, source] of [['facade', controller], ['inner', inner]]) {
					try {
						const found = await source.resolveAgent(SESSION)
						const agent = found?.agent ?? found
						if (agent === undefined || agent?.session === undefined) {
							say(`${label}.selectionFor skipped (agent=${describe(found)})`)
							continue
						}
						const selection = inner.selectionFor(agent)
						say(`${label}.selectionFor current=${JSON.stringify(selection.current)}`)
					} catch (error) {
						say(`${label}.selectionFor FAILED: ${error?.message}\n${error?.stack ?? ''}`)
					}
				}

				try {
					const out = await controller.prompt({
						sessionId: SESSION,
						requestId: `probe-request-${phase}`,
						content: [{ type: 'text', text: '用 read_image 读一下 probe.png，然后用一句话说出图片上的文字。' }]
					}, new AbortController().signal)
					say(`prompt accepted: ${JSON.stringify(out)}`)
				} catch (error) {
					say(`prompt FAILED: ${error?.message}`)
				}
				setTimeout(() => say(`--- phase ${phase} settled ---`), 45000)
			} catch (error) {
				say(`probe threw: ${error?.stack ?? String(error)}`)
			}
		}, 6000)
	})
}
