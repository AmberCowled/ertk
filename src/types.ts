/**
 * Core ERTK type definitions.
 *
 * Generalized from the original Pointwise implementation to be
 * framework-agnostic at the type level.
 */

// ─── Tag Types ────────────────────────────────────────────────

export type TagType = string;

export type TagDescription = TagType | { type: TagType; id: string | number };

// ─── Optimistic Update Types ──────────────────────────────────

export interface SingleOptimistic<TArgs> {
	target: string;
	args: (params: TArgs) => unknown;
	update: (draft: unknown, params: TArgs) => void;
}

export interface MultiOptimistic<TArgs> {
	updates: Array<{
		target: string;
		args: (params: TArgs) => unknown;
		update: (draft: unknown, params: TArgs) => void;
		condition?: (params: TArgs) => boolean;
	}>;
}

// ─── Handler Context ──────────────────────────────────────────

/**
 * Minimal user shape required by ERTK. Consumers extend this
 * via their auth adapter to add project-specific fields.
 */
export interface DefaultUser {
	id: string;
	[key: string]: unknown;
}

/**
 * Context passed to endpoint handlers on the server side.
 */
export interface HandlerContext<
	TBody = unknown,
	TQuery = unknown,
	TUser = DefaultUser,
> {
	user: TUser;
	body: TBody;
	query: TQuery;
	params: Record<string, string>;
	req: Request;
}

// ─── Validation ───────────────────────────────────────────────

/**
 * Minimal validation interface. Compatible with Zod, Valibot, ArkType,
 * or any library that exposes a `parse(data) => T` method.
 */
export interface ValidationSchema<T = unknown> {
	parse: (data: unknown) => T;
}

// ─── Endpoint Definition ──────────────────────────────────────

export interface EndpointDefinition<TResponse = unknown, TArgs = void> {
	/** Name used for the generated RTK Query hook (e.g., "getTasks" → useGetTasksQuery) */
	name: string;

	/** HTTP method */
	method: "get" | "post" | "put" | "patch" | "delete";

	/** Optional request validation schema (Zod, Valibot, etc.) */
	request?: ValidationSchema;

	/** RTK Query cache tag configuration */
	tags?: {
		provides?:
			| TagDescription[]
			| ((
					result: TResponse | undefined,
					error: unknown,
					args: TArgs,
			  ) => TagDescription[]);
		invalidates?:
			| TagDescription[]
			| ((
					result: TResponse | undefined,
					error: unknown,
					args: TArgs,
			  ) => TagDescription[]);
	};

	/** Whether this endpoint requires authentication (default: true) */
	protected: boolean;

	/** Client-side query function for RTK Query */
	query?: (
		args: TArgs,
	) => string | { url: string; method?: string; body?: unknown };

	/** Optimistic update configuration */
	optimistic?: SingleOptimistic<TArgs> | MultiOptimistic<TArgs>;

	/**
	 * Maximum number of retry attempts for transient failures (5xx, network errors, 408, 429).
	 * Uses RTK Query's built-in `retry` utility with exponential backoff.
	 * 0 or undefined means no retries. A value of 2 means up to 3 total attempts.
	 * Client-side only — does not affect server-side route handlers.
	 */
	maxRetries?: number;

	/**
	 * Per-endpoint rate limit override for the server-side route handler.
	 * Overrides the global `rateLimit` config from `configureHandler()`.
	 * Only `windowMs` and `max` can be overridden; `keyFn` and `adapter` come from the global config.
	 */
	rateLimit?: {
		windowMs: number;
		max: number;
	};

	/**
	 * Server-side handler. Optional — omit for client-only endpoints
	 * that consume an external API.
	 */
	handler?: (ctx: HandlerContext<any, any>) => Promise<unknown>;
}

// ─── Config Types ─────────────────────────────────────────────

export interface ErtkRoutesConfig {
	/** Directory where Next.js route files are generated (e.g., "src/app/api") */
	dir: string;

	/**
	 * Module that exports `createRouteHandler`.
	 * Generated route files will import from this module.
	 * Default: "ertk/next"
	 */
	handlerModule?: string;

	/** Top-level route directories to skip during generation (e.g., ["auth"]) */
	ignoredRoutes?: string[];
}

export interface ErtkConfig {
	/** Directory containing endpoint definition files. Default: "src/endpoints" */
	endpoints?: string;

	/** Directory for generated output files. Default: "src/generated" */
	generated?: string;

	/**
	 * Path alias prefix (e.g., "@app", "@src", "@myproject").
	 * If omitted, auto-detected from tsconfig.json paths.
	 */
	pathAlias?: string;

	/** Base URL for fetchBaseQuery. Default: "/api" */
	baseUrl?: string;

	/**
	 * Custom baseQuery source code string. Overrides baseUrl if provided.
	 * Allows full control over fetch configuration (auth headers, etc.).
	 *
	 * @example
	 * ```
	 * baseQuery: `fetchBaseQuery({
	 *   baseUrl: "https://api.example.com",
	 *   prepareHeaders: (headers) => {
	 *     headers.set("Authorization", \`Bearer \${getToken()}\`);
	 *     return headers;
	 *   },
	 * })`
	 * ```
	 */
	baseQuery?: string;

	/**
	 * Filenames that map to CRUD operations and don't become URL segments.
	 * Default: ["get", "list", "create", "update", "delete", "send", "remove", "cancel"]
	 */
	crudFilenames?: string[];

	/**
	 * Route generation config. Omit entirely to skip route generation
	 * (client-only mode).
	 */
	routes?: ErtkRoutesConfig;
}

/**
 * Resolved config with all defaults applied and paths made absolute.
 * Used internally by the codegen.
 */
export interface ResolvedConfig {
	root: string;
	endpointsDir: string;
	generatedDir: string;
	manifestPath: string;
	pathAlias: string;
	aliasRoot: string;
	baseUrl: string;
	baseQuery: string | null;
	crudFilenames: Set<string>;
	routes: {
		dir: string;
		handlerModule: string;
		ignoredRoutes: Set<string>;
	} | null;
}
