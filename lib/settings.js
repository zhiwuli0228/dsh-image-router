/**
 * The editable settings namespace.
 *
 * This is the half that makes the plugin configurable from
 * 设置 → 插件 → 插件配置 instead of only from the profile patch: the Host
 * registers the namespace, and the browser half (`client/client.js`) registers
 * the card that edits it, keyed by {@link SETTINGS_NAMESPACE}. The card and this
 * constant must keep spelling the same value.
 *
 * Two traps this module exists to avoid, both learned from dshmarket's settings
 * half, which hit them first:
 *
 *  1. **Only the service.** `@deepseek-ai/dsh-settings` used to export
 *     `installSettingsSection` and `settingsNamespace` helpers; dsh 0.1.2-alpha.1
 *     deleted them. A missing *named export* is not a missing service: `ctx.inject`
 *     degrades quietly, but an ESM named import that resolves to nothing is a
 *     SyntaxError at module evaluation — cordis reports it as a failed entry and
 *     the host exits 1. So this file imports nothing and reaches the service
 *     through `ctx.inject(['settings'], …)`.
 *  2. **No new dependency.** The schema arrives as an argument, so this module
 *     stays importable from a checkout that has no `node_modules` at all — the
 *     same property the rest of the plugin keeps.
 *
 * Injection is also the graceful-degradation boundary: on a host with no settings
 * service the callback never runs, the composed patch configuration stands, and
 * nothing about the plugin changes.
 *
 * @module image-router/settings
 */

/** Namespace the card on the browser side keys itself to. */
export const SETTINGS_NAMESPACE = 'image-router'

/** The namespace pattern the removed `settingsNamespace` helper used to enforce. */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

if (!NAMESPACE_PATTERN.test(SETTINGS_NAMESPACE)) throw new TypeError(`settings namespace "${SETTINGS_NAMESPACE}" must match ${String(NAMESPACE_PATTERN)}`)

/**
 * Register the namespace and keep the environment's override layer current.
 *
 * `base` is the configuration the loader composed for this entry, so the card
 * shows the values actually in force (a `vision` route that came from the profile
 * patch is visible, not blank) and a save writes the user's layer on top of it.
 * That is also why the same JSON shape serves both layers.
 *
 * @param env - the plugin environment exposing `ctx`, `trace`, and `setOverrides`.
 * @param schema - the configuration schema to validate the section with.
 * @param base - the composed configuration the section starts from.
 * @param onChange - optional callback run after every registration and every
 *   saved change; the endpoint tier uses it to re-push a custom endpoint
 *   upstream. Failures are contained: a throwing callback cannot break the
 *   settings registration that just succeeded.
 */
export function installSettings(env, schema, base, onChange) {
	const notify = () => {
		if (typeof onChange !== 'function') return
		try {
			onChange()
		} catch (error) {
			env.trace(`settings-onChange-failed ${String(error)}`)
		}
	}
	env.ctx.inject(['settings'], (sctx) => {
		try {
			const scope = sctx.settings.register(SETTINGS_NAMESPACE, schema, { base })
			// The section's value object is read live: the settings layer replaces its
			// fields in place, so a saved change reaches the next decision without a
			// restart. The watch is what keeps the audit trail honest about that.
			env.setOverrides(scope.get())
			sctx.effect(() => () => env.setOverrides(undefined), 'image-router: settings namespace')
			scope.watch(() => {
				env.setOverrides(scope.get())
				env.trace(`settings-changed ns=${SETTINGS_NAMESPACE}`)
				notify()
			})
			env.trace(`settings-registered ns=${SETTINGS_NAMESPACE}`)
			notify()
		} catch (error) {
			env.trace(`settings-failed ${String(error)}`)
		}
	})
}
