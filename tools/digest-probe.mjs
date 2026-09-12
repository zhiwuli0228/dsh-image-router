/**
 * One-off diagnostic plugin: prove digest mode in a live profile tree — the
 * session model must stay put while the prompt's image becomes analysis text.
 *
 * This file is a development tool for dsh-image-router, not part of the plugin.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'digest-probe'

/** Paths are derived from this file, so the probe runs from any checkout. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPORT = join(ROOT, 'probe-report.log')
const PNG = join(ROOT, 'probe.png')

/** The session workspace the probe creates its session in. */
const CWD = process.cwd()
const SESSION = 'probe-digest'

const say = (line) => {
	try {
		appendFileSync(REPORT, `${line}\n`)
	} catch {
		/* ignore */
	}
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function apply(ctx) {
	ctx.inject(['sessionController'], (sessionCtx) => {
		setTimeout(async () => {
			say(`--- digest probe at ${new Date().toISOString()} ---`)
			try {
				const controller = sessionCtx.sessionController
				const inner = controller.agents
				const agent = await inner.ensureSession(SESSION, CWD, false)
				const model = () => {
					const current = inner.selectionFor(agent).current
					return `${current.provider}/${current.model}`
				}
				say(`session model before prompt: ${model()}`)

				const data = readFileSync(PNG).toString('base64')
				await controller.prompt({
					sessionId: SESSION,
					requestId: 'probe-digest-1',
					content: [
						{ type: 'text', text: '用一句话说出图片上的文字。' },
						{ type: 'image', mediaType: 'image/png', data, name: 'probe.png' }
					]
				}, new AbortController().signal)
				say('prompt accepted (digest ran before admission)')
				await sleep(50000)
				say(`session model after prompt:  ${model()}`)

				const events = agent.session.snapshotEvents()
				say(`session events: ${events.length}`)
				for (const event of events.slice(-6)) say(`  event ${event.type}: ${JSON.stringify(event.data).slice(0, 400)}`)
				say('--- digest probe done ---')
			} catch (error) {
				say(`digest probe threw: ${error?.stack ?? String(error)}`)
			}
		}, 8000)
	})
}
