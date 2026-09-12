/**
 * The custom-endpoint tier of the vision route.
 *
 * The plugin deliberately does **not** implement its own provider wire code.
 * A user who has an OpenAI-compatible endpoint and a key — a gateway, a
 * self-hosted server, a provider newer than the installed catalog — gets one
 * from `@deepseek-ai/dsh-llm-pi-ai`, which already owns that protocol,
 * discovery, image projection, replay and retry. This module is only the
 * translation layer: it turns the three fields a person can actually supply
 * (endpoint, model, key) into the two pieces of upstream state pi-ai reads.
 *
 *  1. **A route profile** in the `llm-pi-ai` settings namespace, written with
 *     `settings.mutate` so only `providers[ROUTE]` is touched. The user's other
 *     routes, and every other namespace, stay byte-identical.
 *  2. **A credential reference** in the harness credential store (`refs:` in
 *     `$DSH_HOME/.credentials.yaml`, the same layer `QWEN_TOKEN_PLAN_CN_API_KEY`
 *     lives in). The profile carries only the reference name, never the key, so
 *     the secret never enters settings, the trace file, or this plugin's own
 *     configuration.
 *
 * Everything here is best-effort and side-effect-scoped: a deployment without
 * the `llm` service, without pi-ai, or with a read-only settings provider gets a
 * trace line and keeps running with the explicit `vision.provider/model` route.
 *
 * @module image-router/endpoint
 */

/**
 * The route key the derived provider is written under. Fixed rather than
 * per-user, because a settings document is already per-user; a random suffix
 * would only leak stale routes that nothing cleans up.
 */
export const ENDPOINT_PROVIDER = 'image-router-vision'

/**
 * The credential reference holding the key typed into the card.
 *
 * Shell-identifier shape on purpose: this is the `refs:` layer of the
 * credential store, and it is what `vision.endpoint.apiKeyEnv` names. It is
 * also what pi-ai's ambient discovery asks for by name, so a key stored here is
 * found by both paths.
 */
export const ENDPOINT_KEY_REF = 'IMAGE_ROUTER_VISION_API_KEY'

/** Wire protocols the endpoint tier accepts, matching pi-ai's supported set. */
export const ENDPOINT_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages']

/** The protocol assumed when the card leaves the field empty. */
export const DEFAULT_ENDPOINT_API = 'openai-completions'

/** Endpoint display name shown by model selectors. */
const DEFAULT_ENDPOINT_NAME = 'Image Router Vision'

/**
 * Whether a value is a non-empty string.
 *
 * @param value - candidate.
 * @returns whether it is usable as typed text.
 */
function filled(value) {
	return typeof value === 'string' && value.trim().length > 0
}

/**
 * Read and validate the `vision.endpoint` object.
 *
 * A schema may materialize an unset optional object as `{}`; that is "absent",
 * not "configured with missing fields", so an object with no filled field
 * returns `undefined` rather than a problem.
 *
 * @param value - the raw `vision.endpoint` value.
 * @param label - problem prefix.
 * @param problems - collector for human-readable validation failures.
 * @returns the normalized endpoint, or `undefined` when unset/invalid.
 */
export function readEndpoint(value, label, problems) {
	if (value === undefined || value === null) return undefined
	if (typeof value !== 'object' || Array.isArray(value)) {
		problems.push(`${label} must be an object with baseURL and model`)
		return undefined
	}
	const { baseURL, model, api, name, apiKeyEnv } = value
	const apiKey = value.apiKey
	const images = value.images
	// "Absent" is judged by keys, not by values: an object the card actually
	// wrote with blank fields is a half-filled endpoint the user must be told
	// about, while `{}` is what a schema materializes for an unset optional.
	const anyKey = [baseURL, model, api, name, apiKeyEnv, apiKey, images].some((entry) => entry !== undefined && entry !== null)
	if (!anyKey) return undefined
	if (images !== undefined && images !== null && typeof images !== 'boolean') problems.push(`${label}.images must be a boolean`)
	if (!filled(baseURL)) problems.push(`${label}.baseURL must be a non-empty URL`)
	if (!filled(model)) problems.push(`${label}.model must be a non-empty model id`)
	if (api !== undefined && !filled(api)) problems.push(`${label}.api must be one of ${ENDPOINT_APIS.join(', ')}`)
	else if (api !== undefined && !ENDPOINT_APIS.includes(api)) problems.push(`${label}.api must be one of ${ENDPOINT_APIS.join(', ')}`)
	if (name !== undefined && name !== null && typeof name !== 'string') problems.push(`${label}.name must be a string`)
	if (apiKeyEnv !== undefined && filled(apiKeyEnv)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) problems.push(`${label}.apiKeyEnv must be a shell-style identifier such as ${ENDPOINT_KEY_REF}`)
	}
	if (problems.length > 0) return undefined
	return {
		baseURL: baseURL.trim(),
		model: model.trim(),
		api: filled(api) ? api : DEFAULT_ENDPOINT_API,
		// Image input is the reason this route exists, so it is declared by default.
		images: images === undefined || images === null ? true : images,
		...(filled(name) ? { name: name.trim() } : {}),
		...(filled(apiKeyEnv) ? { apiKeyEnv: apiKeyEnv.trim() } : {}),
		// The key is presence-only after this point: it is written to the credential
		// store and never echoed back into the settings section.
		...(filled(apiKey) ? { apiKey: apiKey.trim() } : {})
	}
}

/**
 * The route the endpoint tier resolves to, in the same shape as an explicit
 * `vision` route so every consumer stays unaware of which tier produced it.
 *
 * @param endpoint - a normalized endpoint.
 * @returns a `{ provider, model }` selection.
 */
export function routeForEndpoint(endpoint) {
	return { provider: ENDPOINT_PROVIDER, model: endpoint.model }
}

/**
 * The `llm-pi-ai` route profile for one endpoint.
 *
 * `api` and `baseURL` are what turn a hand-declared gateway into a route pi-ai
 * can reach; `models` replaces the route's catalog wholesale, which is exactly
 * right for a route pi-ai ships nothing about. `apiKeyEnv` is a *reference*, so
 * no secret is stored here.
 *
 * @param endpoint - a normalized endpoint.
 * @returns the profile object written at `providers[ENDPOINT_PROVIDER]`.
 */
export function endpointProfile(endpoint) {
	const keyRef = endpoint.apiKeyEnv ?? ENDPOINT_KEY_REF
	return {
		displayName: endpoint.name ?? DEFAULT_ENDPOINT_NAME,
		api: endpoint.api,
		baseURL: endpoint.baseURL,
		apiKeyEnv: keyRef,
		// The modality declaration is not optional in practice: pi-ai's
		// `defaultInput` is `["text"]`, so a route that declares nothing is a
		// text-only route, and an image sent to it is projected to a placeholder
		// instead of reaching the endpoint. This is the one field that makes the
		// derived route actually usable for the purpose it exists for.
		models: [{ id: endpoint.model, input: endpoint.images === false ? ['text'] : ['text', 'image'] }]
	}
}

/**
 * The single `set` operation the endpoint tier owns inside `llm-pi-ai`.
 *
 * Path-addressed rather than a whole-section `replace` because another card may
 * own other routes in the same namespace; this touches exactly one key.
 *
 * @returns one settings path operation.
 */
export function endpointSettingsOp(endpoint) {
	return { op: 'set', path: ['providers', ENDPOINT_PROVIDER], value: endpointProfile(endpoint) }
}

/** The operation that withdraws the derived route. */
export function endpointCleanupOp() {
	return { op: 'unset', path: ['providers', ENDPOINT_PROVIDER] }
}

/**
 * Apply the endpoint tier to the upstream services.
 *
 * Never throws: every failure is a trace line, because a configuration problem
 * here must not disable image routing that may still work through the explicit
 * route, and must never fail the host.
 *
 * @param services - `{ settings, credentials, trace }`; any may be absent.
 * @param endpoint - the normalized endpoint, or `undefined` to withdraw.
 * @returns a short outcome string for the caller's audit line.
 */
export async function syncEndpoint(services, endpoint) {
	const trace = typeof services.trace === 'function' ? services.trace : () => {}
	const settings = services.settings
	const credentials = services.credentials

	if (endpoint === undefined) {
		if (settings === undefined) return 'endpoint-withdraw-skipped no settings service'
		try {
			await settings.mutate('llm-pi-ai', [endpointCleanupOp()])
			return 'endpoint-withdrawn'
		} catch (error) {
			return `endpoint-withdraw-failed ${String(error)}`
		}
	}

	if (settings === undefined) {
		trace('endpoint-skipped no settings service')
		return 'endpoint-skipped no settings service'
	}

	try {
		await settings.mutate('llm-pi-ai', [endpointSettingsOp(endpoint)])
	} catch (error) {
		trace(`endpoint-route-failed ${String(error)}`)
		return `endpoint-route-failed ${String(error)}`
	}

	if (filled(endpoint.apiKey)) {
		const ref = endpoint.apiKeyEnv ?? ENDPOINT_KEY_REF
		if (credentials === undefined) {
			trace(`endpoint-key-skipped no credentials service ref=${ref}`)
			return 'endpoint-route-ok key-skipped'
		}
		try {
			await credentials.set(ref, endpoint.apiKey)
			// The key itself is never traced; only the reference it landed under.
			trace(`endpoint-key-stored ref=${ref}`)
			return 'endpoint-route-ok key-stored'
		} catch (error) {
			trace(`endpoint-key-failed ${String(error)}`)
			return `endpoint-key-failed ${String(error)}`
		}
	}

	return 'endpoint-route-ok'
}
