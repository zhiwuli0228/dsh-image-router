/**
 * One-off diagnostic plugin: drive a real prompt sequence through the live
 * session controller and record which route each turn actually ran on.
 *
 * This file is a development tool for dsh-image-router, not part of the plugin.
 */
import { appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'router-sequence-probe'

/** Paths are derived from this file, so the probe runs from any checkout. */
const REPORT = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'probe-report.log')

/** The session workspace the probe creates its session in. */
const CWD = process.cwd()
const SESSION = 'probe-image-router'

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
			say(`--- sequence probe at ${new Date().toISOString()} ---`)
			try {
				const controller = sessionCtx.sessionController
				const inner = controller.agents
				const agent = await inner.ensureSession(SESSION, CWD, false)
				say(`agent ready: ${agent?.constructor?.name ?? '?'} session=${agent?.session?.header?.id ?? '?'}`)
				const state = (label) => {
					try {
						say(`${label}: current=${JSON.stringify(inner.selectionFor(agent).current)}`)
					} catch (error) {
						say(`${label}: selectionFor threw ${error?.message}`)
					}
				}
				state('start')

				await controller.prompt({
					sessionId: SESSION,
					requestId: 'probe-seq-1',
					content: [{ type: 'text', text: '用 read_image 读一下 probe.png，然后用一句话说出图片上的文字。' }]
				}, new AbortController().signal)
				say('prompt1 (mentions probe.png) accepted')
				await sleep(30000)
				state('after image turn')

				await controller.prompt({ sessionId: SESSION, requestId: 'probe-seq-2', content: [{ type: 'text', text: '只回复 OK' }] }, new AbortController().signal)
				say('prompt2 (plain, follow-up) accepted')
				await sleep(25000)
				state('after follow-up 1')

				await controller.prompt({ sessionId: SESSION, requestId: 'probe-seq-3', content: [{ type: 'text', text: '只回复 OK' }] }, new AbortController().signal)
				say('prompt3 (plain, released) accepted')
				await sleep(25000)
				state('after follow-up 2')
				say('--- sequence done ---')
			} catch (error) {
				say(`sequence probe threw: ${error?.stack ?? String(error)}`)
			}
		}, 8000)
	})
}
