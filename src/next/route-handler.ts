/**
 * ERTK Next.js Route Handler
 *
 * Generic createRouteHandler that bridges EndpointDefinition to
 * Next.js App Router route handlers. Decoupled from any specific
 * auth or database implementation.
 */

import type { EndpointDefinition } from "../types.js";
import {
	defaultKeyFn,
	InMemoryRateLimitAdapter,
	type RateLimitAdapter,
	type RateLimitConfig,
} from "./rate-limit.js";

// ─── Types ────────────────────────────────────────────────────

/**
 * Auth adapter interface. Consumers implement this to provide
 * user resolution for protected endpoints.
 */
export interface ErtkAuthAdapter<
	TUser extends { id: string } = { id: string; [key: string]: unknown },
> {
	/**
	 * Resolve the authenticated user from a request.
	 * Return null if the user is not authenticated.
	 */
	getUser: (req: Request) => Promise<TUser | null>;
}

/**
 * Error handler interface. Consumers can provide custom error
 * handling logic (e.g., for ORM-specific errors).
 */
export interface ErtkErrorHandler {
	(error: unknown): Response | null;
}

/**
 * Options for configuring the route handler factory.
 */
export interface ConfigureHandlerOptions {
	/** Auth adapter for resolving users on protected endpoints */
	auth?: ErtkAuthAdapter;

	/** Custom error handlers, processed in order. First non-null response wins. */
	errorHandlers?: ErtkErrorHandler[];

	/**
	 * Global rate limiting configuration.
	 * Applied to all endpoints unless overridden per-endpoint.
	 * Omit to disable rate limiting entirely.
	 */
	rateLimit?: RateLimitConfig;
}

// ─── Validation Error ─────────────────────────────────────────

class ValidationError extends Error {
	public issues?: Array<{ path: string; message: string }>;

	constructor(message: string, issues?: Array<{ path: string; message: string }>) {
		super(message);
		this.name = "ValidationError";
		this.issues = issues;
	}
}

// ─── Request Parsing ──────────────────────────────────────────

const QUERY_METHODS = new Set(["GET", "DELETE", "HEAD", "OPTIONS"]);

async function parseAndValidateRequest(
	req: Request,
	schema?: { parse: (data: unknown) => unknown },
): Promise<{ body?: unknown; query?: unknown }> {
	const method = req.method.toUpperCase();
	const isQueryMethod = QUERY_METHODS.has(method);

	if (isQueryMethod) {
		if (!schema) return { query: undefined };

		const url = new URL(req.url);
		const params: Record<string, string | number> = {};
		url.searchParams.forEach((value, key) => {
			const numValue = Number(value);
			params[key] = Number.isNaN(numValue) ? value : numValue;
		});

		try {
			const data = schema.parse(params);
			return { query: data };
		} catch (err) {
			throw toValidationError(err);
		}
	} else {
		if (!schema) return { body: undefined };

		let body: unknown;
		try {
			body = await req.json();
		} catch {
			throw new ValidationError("Invalid JSON in request body");
		}

		try {
			const data = schema.parse(body);
			return { body: data };
		} catch (err) {
			throw toValidationError(err);
		}
	}
}

function toValidationError(err: unknown): ValidationError {
	// Handle Zod errors (v3 and v4)
	if (
		err &&
		typeof err === "object" &&
		"issues" in err &&
		Array.isArray((err as { issues: unknown[] }).issues)
	) {
		const issues = (
			err as { issues: Array<{ path: unknown[]; message: string }> }
		).issues.map((issue) => ({
			path: issue.path.map(String).join("."),
			message: issue.message,
		}));
		return new ValidationError("Validation failed", issues);
	}

	if (err instanceof Error) {
		return new ValidationError(err.message);
	}

	return new ValidationError("Validation failed");
}

// ─── JSON Helpers ─────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function errorResponse(message: string, status: number): Response {
	return jsonResponse({ error: message }, status);
}

// ─── Rate Limiting ────────────────────────────────────────────

let defaultAdapter: RateLimitAdapter | null = null;
function getDefaultAdapter(): RateLimitAdapter {
	if (!defaultAdapter) {
		defaultAdapter = new InMemoryRateLimitAdapter();
	}
	return defaultAdapter;
}

async function applyRateLimit(
	req: Request,
	user: { id: string } | undefined,
	globalConfig: RateLimitConfig | undefined,
	endpointOverride: { windowMs: number; max: number } | undefined,
): Promise<Response | null> {
	if (!globalConfig && !endpointOverride) return null;

	const windowMs = endpointOverride?.windowMs ?? globalConfig!.windowMs;
	const max = endpointOverride?.max ?? globalConfig!.max;
	const keyFn = globalConfig?.keyFn ?? defaultKeyFn;
	const adapter = globalConfig?.adapter ?? getDefaultAdapter();

	const key = keyFn(req, user);
	const result = await adapter.check(key, windowMs, max);

	if (!result.allowed) {
		const retryAfter = Math.ceil(
			(result.resetAt * 1000 - Date.now()) / 1000,
		);
		return new Response(JSON.stringify({ error: "Too many requests" }), {
			status: 429,
			headers: {
				"Content-Type": "application/json",
				"Retry-After": String(Math.max(1, retryAfter)),
				"X-RateLimit-Limit": String(result.limit),
				"X-RateLimit-Remaining": "0",
				"X-RateLimit-Reset": String(result.resetAt),
			},
		});
	}

	return null;
}

// ─── Route Handler Factory ───────────────────────────────────

/**
 * Create a configured route handler factory. Call this once with your
 * auth adapter and error handlers, then use the returned function
 * to create individual route handlers.
 *
 * @example
 * ```typescript
 * // src/lib/ertk-handler.ts
 * import { configureHandler } from "ertk/next";
 *
 * export const createRouteHandler = configureHandler({
 *   auth: {
 *     getUser: async (req) => {
 *       const session = await getServerSession(authOptions);
 *       if (!session?.user?.email) return null;
 *       return await db.user.findUnique({ where: { email: session.user.email } });
 *     },
 *   },
 *   errorHandlers: [
 *     (error) => {
 *       if (error instanceof Prisma.PrismaClientKnownRequestError) {
 *         if (error.code === "P2025") return errorResponse("Not found", 404);
 *       }
 *       return null;
 *     },
 *   ],
 * });
 * ```
 */
export function configureHandler(options: ConfigureHandlerOptions = {}) {
	return function createRouteHandler(
		def: EndpointDefinition<any, any>,
	) {
		return async (
			req: Request,
			ctx?: { params: Promise<Record<string, string>> },
		): Promise<Response> => {
			try {
				const params = ctx?.params ? await ctx.params : {};

				// Parse and validate request
				const { body, query } = await parseAndValidateRequest(
					req,
					def.request,
				);

				// Resolve user for protected endpoints
				let user: unknown = undefined;
				if (def.protected) {
					if (!options.auth) {
						return errorResponse(
							"No auth adapter configured for protected endpoint",
							500,
						);
					}
					user = await options.auth.getUser(req);
					if (!user) {
						return errorResponse("Unauthorized", 401);
					}
				}

				// Rate limiting
				if (options.rateLimit || def.rateLimit) {
					const rateLimitResponse = await applyRateLimit(
						req,
						user as { id: string } | undefined,
						options.rateLimit,
						def.rateLimit,
					);
					if (rateLimitResponse) return rateLimitResponse;
				}

				// Call the endpoint handler
				if (!def.handler) {
					return errorResponse(
						"No handler defined for this endpoint",
						501,
					);
				}

				const result = await def.handler({
					user: (user ?? { id: "" }) as any,
					body,
					query,
					params,
					req,
				});

				return jsonResponse(result);
			} catch (error) {
				// Run custom error handlers
				if (options.errorHandlers) {
					for (const handler of options.errorHandlers) {
						const response = handler(error);
						if (response) return response;
					}
				}

				// Handle validation errors
				if (error instanceof ValidationError) {
					if (error.issues) {
						return jsonResponse(
							{ error: "Validation failed", details: error.issues },
							400,
						);
					}
					return errorResponse(error.message, 400);
				}

				// Handle errors with a status property
				if (
					error instanceof Error &&
					"status" in error &&
					typeof (error as { status: unknown }).status === "number"
				) {
					return errorResponse(
						error.message || "An error occurred",
						(error as { status: number }).status,
					);
				}

				// Generic error
				if (error instanceof Error) {
					console.error("ERTK Route Error:", {
						message: error.message,
						stack: error.stack,
					});
				} else {
					console.error("ERTK Route Error:", error);
				}

				return errorResponse("An unexpected error occurred", 500);
			}
		};
	};
}

/**
 * Default createRouteHandler with no auth or custom error handling.
 * Suitable for unprotected endpoints or quick prototyping.
 *
 * For protected endpoints, use `configureHandler()` with an auth adapter.
 */
export const createRouteHandler = configureHandler();
