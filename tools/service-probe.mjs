/**
 * One-off diagnostic plugin: report which DSH service actually exposes the
 * session model-selection methods, from inside a live profile tree.
 *
 * This file is a development tool for dsh-image-router, not part of the plugin.
 */
import { appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'service-probe'

/** Paths are derived from this file, so the probe runs from any checkout. */
const REPORT = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'probe-report.log')
const CANDIDATES = ['agents', 'sessionController', 'session', 'sessions', 'agentDefaultModel', 'sessionProjections', 'llm', 'attachments']
const METHODS = ['prompt', 'resolveAgent', 'selectionFor', 'selectForNextRequest', 'selectModel', 'ensureSession', 'get', 'list']

const say = (line) => {
	try {
		appendFileSync(REPORT, `${line}\n`)
	} catch {
		/* ignore */
	}
}

export function apply(ctx) {
	say(`--- probe at ${new Date().toISOString()} ---`)
	for (const key of CANDIDATES) {
		let value
		try {
			value = ctx.get(key)
		} catch (error) {
			say(`${key}: get() threw ${String(error)}`)
			continue
		}
		if (value === undefined || value === null) {
			say(`${key}: absent (${String(value)})`)
			continue
		}
		const shape = METHODS.map((method) => `${method}=${typeof value[method]}`).join(' ')
		let ctor = '?'
		try {
			ctor = value.constructor?.name ?? '?'
		} catch {
			/* ignore */
		}
		say(`${key}: ctor=${ctor} ${shape}`)
		let proto = Object.getPrototypeOf(value)
		const chain = []
		while (proto !== null && proto !== Object.prototype) {
			chain.push(proto.constructor?.name ?? 'anon')
			proto = Object.getPrototypeOf(proto)
		}
		say(`${key}: prototype chain = ${chain.join(' -> ')}`)
		if (key === 'sessionController' || key === 'agents') {
			try {
				say(`${key}: own keys = ${Object.keys(value).join(',')}`)
			} catch {
				/* ignore */
			}
		}
	}
	say('--- end ---')
}
