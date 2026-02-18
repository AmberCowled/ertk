import type { EndpointDefinition } from "./types.js";

function createFactory(method: EndpointDefinition["method"]) {
	return <TResponse, TArgs = void>(
		config: Omit<EndpointDefinition<TResponse, TArgs>, "method">,
	): EndpointDefinition<TResponse, TArgs> => ({
		...config,
		method,
		protected: config.protected ?? true,
	});
}

export const endpoint = {
	get: createFactory("get"),
	post: createFactory("post"),
	put: createFactory("put"),
	patch: createFactory("patch"),
	delete: createFactory("delete"),
};
