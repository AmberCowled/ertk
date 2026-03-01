/**
 * ERTK Codegen Engine
 *
 * Reads endpoint definition files and generates:
 * - api.ts (RTK Query API + hooks)
 * - store.ts (Redux store config)
 * - invalidation.ts (cache invalidation helpers)
 * - route.ts files (Next.js route handlers) — if routes config is present
 */

import { Project, SyntaxKind } from "ts-morph";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedConfig } from "./types.js";

// ─── Internal Types ───────────────────────────────────────────

interface ParsedEndpoint {
	name: string;
	method: string;
	filePath: string;
	importPath: string;
	routePath: string;
	isProtected: boolean;
	hasRequest: boolean;
	hasHandler: boolean;

	responseType: string;
	responseTypeImport: string | null;
	argsType: string;
	argsTypeImport: string | null;
	queryFnSource: string;
	endpointType: "query" | "mutation";

	providesTagsSource: string | null;
	invalidatesTagsSource: string | null;
	optimisticSource: string | null;
	maxRetries: number | null;

	typeImports: Map<string, Set<string>>;
}

interface RouteGroup {
	routePath: string;
	appRouteDir: string;
	methods: Map<string, ParsedEndpoint>;
}

// ─── AST Parsing ──────────────────────────────────────────────

function parseEndpointFile(
	project: Project,
	filePath: string,
	config: ResolvedConfig,
): ParsedEndpoint | null {
	const absPath = path.join(config.endpointsDir, filePath);
	const sourceFile = project.addSourceFileAtPath(absPath);

	// Find the default export
	const defaultExport = sourceFile.getDefaultExportSymbol();
	if (!defaultExport) {
		console.warn(`ERTK: No default export in ${filePath}, skipping`);
		return null;
	}

	// Find the endpoint.{method}(...) call
	const callExpressions = sourceFile.getDescendantsOfKind(
		SyntaxKind.CallExpression,
	);

	let endpointCall = null;
	let method = "";

	for (const call of callExpressions) {
		const expr = call.getExpression();
		if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
			const propAccess = expr.asKindOrThrow(
				SyntaxKind.PropertyAccessExpression,
			);
			const objectText = propAccess.getExpression().getText();
			const methodName = propAccess.getName();

			if (
				objectText === "endpoint" &&
				["get", "post", "put", "patch", "delete"].includes(methodName)
			) {
				endpointCall = call;
				method = methodName;
				break;
			}
		}
	}

	if (!endpointCall || !method) {
		console.warn(
			`ERTK: No endpoint.{method}() call found in ${filePath}, skipping`,
		);
		return null;
	}

	// Extract type arguments
	const typeArgs = endpointCall.getTypeArguments();
	const responseType = typeArgs[0]?.getText() ?? "unknown";
	const argsType = typeArgs[1]?.getText() ?? "void";

	// Extract config object
	const configArg = endpointCall.getArguments()[0];
	if (
		!configArg ||
		configArg.getKind() !== SyntaxKind.ObjectLiteralExpression
	) {
		console.warn(
			`ERTK: Config argument not found in ${filePath}, skipping`,
		);
		return null;
	}

	const configObj = configArg.asKindOrThrow(
		SyntaxKind.ObjectLiteralExpression,
	);

	// Extract name
	const nameProp = configObj.getProperty("name");
	const name = nameProp
		? nameProp
				.asKindOrThrow(SyntaxKind.PropertyAssignment)
				.getInitializerOrThrow()
				.getText()
				.replace(/['"]/g, "")
		: "";

	if (!name) {
		console.warn(`ERTK: No name property in ${filePath}, skipping`);
		return null;
	}

	// Extract protected
	const protectedProp = configObj.getProperty("protected");
	const isProtected = protectedProp
		? protectedProp
				.asKindOrThrow(SyntaxKind.PropertyAssignment)
				.getInitializerOrThrow()
				.getText() !== "false"
		: true;

	// Check for request schema
	const requestProp = configObj.getProperty("request");
	const hasRequest = !!requestProp;

	// Check for handler
	const handlerProp = configObj.getProperty("handler");
	const hasHandler = !!handlerProp;

	// Extract query function source
	const queryProp = configObj.getProperty("query");
	let queryFnSource = "";
	if (queryProp) {
		const init = queryProp
			.asKindOrThrow(SyntaxKind.PropertyAssignment)
			.getInitializerOrThrow();
		queryFnSource = init.getText();
	}

	// Extract tags
	let providesTagsSource: string | null = null;
	let invalidatesTagsSource: string | null = null;

	const tagsProp = configObj.getProperty("tags");
	if (tagsProp) {
		const tagsObj = tagsProp
			.asKindOrThrow(SyntaxKind.PropertyAssignment)
			.getInitializerOrThrow();

		if (tagsObj.getKind() === SyntaxKind.ObjectLiteralExpression) {
			const tagsObjLit = tagsObj.asKindOrThrow(
				SyntaxKind.ObjectLiteralExpression,
			);

			const providesProp = tagsObjLit.getProperty("provides");
			if (providesProp) {
				providesTagsSource = providesProp
					.asKindOrThrow(SyntaxKind.PropertyAssignment)
					.getInitializerOrThrow()
					.getText();
			}

			const invalidatesProp = tagsObjLit.getProperty("invalidates");
			if (invalidatesProp) {
				invalidatesTagsSource = invalidatesProp
					.asKindOrThrow(SyntaxKind.PropertyAssignment)
					.getInitializerOrThrow()
					.getText();
			}
		}
	}

	// Extract optimistic updates
	const optimisticProp = configObj.getProperty("optimistic");
	let optimisticSource: string | null = null;
	if (optimisticProp) {
		optimisticSource = optimisticProp
			.asKindOrThrow(SyntaxKind.PropertyAssignment)
			.getInitializerOrThrow()
			.getText();
	}

	// Extract maxRetries
	const maxRetriesProp = configObj.getProperty("maxRetries");
	let maxRetries: number | null = null;
	if (maxRetriesProp) {
		const val = parseInt(
			maxRetriesProp
				.asKindOrThrow(SyntaxKind.PropertyAssignment)
				.getInitializerOrThrow()
				.getText(),
			10,
		);
		if (!Number.isNaN(val) && val > 0) {
			maxRetries = val;
		}
	}

	// Derive route path from file path
	const routePath = deriveRoutePath(filePath, config);
	const endpointType = method === "get" ? "query" : "mutation";

	// Resolve type imports
	const typeImports = new Map<string, Set<string>>();
	let responseTypeImport: string | null = null;
	let argsTypeImport: string | null = null;

	for (const importDecl of sourceFile.getImportDeclarations()) {
		const namedImports = importDecl.getNamedImports();
		for (const named of namedImports) {
			const importName = named.getName();
			const moduleSpecifier = importDecl.getModuleSpecifierValue();
			const aliasPath = resolveToAlias(moduleSpecifier, absPath, config);

			if (responseType.includes(importName)) {
				responseTypeImport = aliasPath;
				addToMapSet(typeImports, aliasPath, importName);
			}
			if (argsType.includes(importName)) {
				argsTypeImport = aliasPath;
				addToMapSet(typeImports, aliasPath, importName);
			}
		}
	}

	// Build import path for endpoint file
	const endpointsRelative = path.relative(config.aliasRoot, config.endpointsDir);
	const importPath = `${config.pathAlias}/${endpointsRelative}/${filePath.replace(/\.ts$/, "")}`;

	return {
		name,
		method,
		filePath,
		importPath,
		routePath,
		isProtected,
		hasRequest,
		hasHandler,
		responseType,
		responseTypeImport,
		argsType,
		argsTypeImport,
		queryFnSource,
		endpointType,
		providesTagsSource,
		invalidatesTagsSource,
		optimisticSource,
		maxRetries,
		typeImports,
	};
}

function resolveToAlias(
	moduleSpecifier: string,
	fromFile: string,
	config: ResolvedConfig,
): string {
	if (moduleSpecifier.startsWith(config.pathAlias + "/")) {
		return moduleSpecifier;
	}
	// Resolve relative path to absolute, then convert to alias
	const dir = path.dirname(fromFile);
	const resolved = path.resolve(dir, moduleSpecifier);
	if (resolved.startsWith(config.aliasRoot)) {
		return `${config.pathAlias}/${path.relative(config.aliasRoot, resolved).replace(/\.ts$/, "")}`;
	}
	return moduleSpecifier;
}

function addToMapSet(
	map: Map<string, Set<string>>,
	key: string,
	value: string,
): void {
	if (!map.has(key)) {
		map.set(key, new Set());
	}
	map.get(key)!.add(value);
}

function deriveRoutePath(filePath: string, config: ResolvedConfig): string {
	const parts = filePath.replace(/\.ts$/, "").split("/");
	const fileName = parts.pop()!;
	const segments: string[] = [];

	for (const part of parts) {
		segments.push(part);
	}

	if (!config.crudFilenames.has(fileName)) {
		segments.push(fileName);
	}

	return `/api/${segments.join("/")}`;
}

// ─── Route Grouping ───────────────────────────────────────────

function groupEndpointsByRoute(
	endpoints: ParsedEndpoint[],
	config: ResolvedConfig,
): Map<string, RouteGroup> {
	const groups = new Map<string, RouteGroup>();

	if (!config.routes) return groups;

	for (const ep of endpoints) {
		if (!ep.hasHandler) continue; // Skip client-only endpoints

		if (!groups.has(ep.routePath)) {
			const appRouteDir = path.join(
				config.routes.dir,
				ep.routePath.replace(/^\/api\//, ""),
			);
			groups.set(ep.routePath, {
				routePath: ep.routePath,
				appRouteDir,
				methods: new Map(),
			});
		}
		const httpMethod = ep.method.toUpperCase();
		groups.get(ep.routePath)!.methods.set(httpMethod, ep);
	}

	return groups;
}

// ─── Code Generation ──────────────────────────────────────────

function generateApiTs(
	endpoints: ParsedEndpoint[],
	config: ResolvedConfig,
): string {
	// Collect all type imports
	const allTypeImports = new Map<string, Set<string>>();
	for (const ep of endpoints) {
		for (const [importPath, types] of ep.typeImports) {
			if (!allTypeImports.has(importPath)) {
				allTypeImports.set(importPath, new Set());
			}
			for (const t of types) {
				allTypeImports.get(importPath)!.add(t);
			}
		}
	}

	// Collect all tag types used
	const tagTypes = new Set<string>();
	for (const ep of endpoints) {
		extractTagTypes(ep.providesTagsSource, tagTypes);
		extractTagTypes(ep.invalidatesTagsSource, tagTypes);
	}

	const hasAnyRetries = endpoints.some(
		(ep) => ep.maxRetries != null && ep.maxRetries > 0,
	);

	const lines: string[] = [];
	lines.push("// AUTO-GENERATED by ERTK codegen. Do not edit.");
	if (hasAnyRetries) {
		lines.push(
			'import { createApi, fetchBaseQuery, retry } from "@reduxjs/toolkit/query/react";',
		);
	} else {
		lines.push(
			'import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";',
		);
	}

	// Add type imports
	for (const [importPath, types] of [...allTypeImports.entries()].sort()) {
		const typeList = [...types].sort().join(", ");
		lines.push(`import type { ${typeList} } from "${importPath}";`);
	}

	lines.push("");
	lines.push("export const api = createApi({");
	lines.push('\treducerPath: "api",');

	// baseQuery — use custom source if provided, otherwise default
	// When retries are used, wrap with retry() and set maxRetries: 0 as default
	// so only endpoints with explicit extraOptions.maxRetries will retry.
	if (hasAnyRetries) {
		if (config.baseQuery) {
			lines.push(
				`\tbaseQuery: retry(${config.baseQuery}, { maxRetries: 0 }),`,
			);
		} else {
			lines.push(
				`\tbaseQuery: retry(fetchBaseQuery({ baseUrl: "${config.baseUrl}" }), { maxRetries: 0 }),`,
			);
		}
	} else if (config.baseQuery) {
		lines.push(`\tbaseQuery: ${config.baseQuery},`);
	} else {
		lines.push(
			`\tbaseQuery: fetchBaseQuery({ baseUrl: "${config.baseUrl}" }),`,
		);
	}

	const tagTypesList = [...tagTypes].sort();
	lines.push(
		`\ttagTypes: [${tagTypesList.map((t) => `"${t}"`).join(", ")}],`,
	);
	lines.push("\trefetchOnFocus: false,");
	lines.push("\trefetchOnReconnect: true,");
	lines.push("\tendpoints: (builder) => ({");

	for (const ep of endpoints) {
		lines.push(...generateEndpointDef(ep));
	}

	lines.push("\t}),");
	lines.push("});");

	// Export hooks
	lines.push("");
	const hookExports: string[] = [];
	for (const ep of endpoints) {
		if (ep.endpointType === "query") {
			hookExports.push(`use${capitalize(ep.name)}Query`);
		} else {
			hookExports.push(`use${capitalize(ep.name)}Mutation`);
		}
	}

	lines.push("export const {");
	for (const hook of hookExports) {
		lines.push(`\t${hook},`);
	}
	lines.push("} = api;");

	return lines.join("\n") + "\n";
}

function generateEndpointDef(ep: ParsedEndpoint): string[] {
	const lines: string[] = [];
	const builderType =
		ep.endpointType === "query" ? "builder.query" : "builder.mutation";

	lines.push(
		`\t\t${ep.name}: ${builderType}<${ep.responseType}, ${ep.argsType}>({`,
	);

	if (ep.queryFnSource) {
		lines.push(`\t\t\tquery: ${ep.queryFnSource},`);
	}

	if (ep.providesTagsSource) {
		lines.push(`\t\t\tprovidesTags: ${ep.providesTagsSource},`);
	}

	if (ep.invalidatesTagsSource) {
		lines.push(`\t\t\tinvalidatesTags: ${ep.invalidatesTagsSource},`);
	}

	if (ep.optimisticSource) {
		const onQueryStarted = generateOnQueryStarted(ep);
		if (onQueryStarted) {
			lines.push(...onQueryStarted);
		}
	}

	if (ep.maxRetries != null && ep.maxRetries > 0) {
		lines.push(`\t\t\textraOptions: { maxRetries: ${ep.maxRetries} },`);
	}

	lines.push("\t\t}),");
	return lines;
}

function generateOnQueryStarted(ep: ParsedEndpoint): string[] | null {
	if (!ep.optimisticSource) return null;

	const lines: string[] = [];
	const isSingle = ep.optimisticSource.includes("target:");
	const isMulti = ep.optimisticSource.includes("updates:");

	if (isSingle && !isMulti) {
		const targetMatch = ep.optimisticSource.match(
			/target:\s*["'](\w+)["']/,
		);
		const argsMatch = ep.optimisticSource.match(
			/args:\s*((?:\([^)]*\)|\w+)\s*=>[\s\S]*?)(?=,\s*update:)/,
		);
		const updateMatch = ep.optimisticSource.match(
			/update:\s*((?:\([^)]*\)|\w+)\s*=>[\s\S]*?)(?=,?\s*}$)/,
		);

		if (targetMatch && argsMatch && updateMatch) {
			const target = targetMatch[1];
			const argsFn = argsMatch[1].trim();
			const updateFn = updateMatch[1].trim();

			lines.push(
				`\t\t\tasync onQueryStarted(params, { dispatch, queryFulfilled }) {`,
			);
			lines.push(`\t\t\t\tconst patchResult = dispatch(`);
			lines.push(
				`\t\t\t\t\tapi.util.updateQueryData("${target}", (${argsFn})(params), (draft) => {`,
			);
			lines.push(`\t\t\t\t\t\t(${updateFn})(draft, params);`);
			lines.push(`\t\t\t\t\t}),`);
			lines.push(`\t\t\t\t);`);
			lines.push(
				`\t\t\t\ttry { await queryFulfilled; } catch { patchResult.undo(); }`,
			);
			lines.push(`\t\t\t},`);
		}
	} else if (isMulti) {
		lines.push(
			`\t\t\tasync onQueryStarted(params, { dispatch, queryFulfilled }) {`,
		);
		lines.push(
			`\t\t\t\tconst patches: Array<{ undo: () => void }> = [];`,
		);

		const updatesContent = extractUpdatesArray(ep.optimisticSource);
		if (updatesContent) {
			for (const update of updatesContent) {
				const targetMatch = update.match(/target:\s*["'](\w+)["']/);
				const conditionMatch = update.match(
					/condition:\s*((?:\([^)]*\)|\w+)\s*=>[^,}]*)/,
				);
				const argsMatch = update.match(
					/args:\s*((?:\([^)]*\)|\w+)\s*=>[\s\S]*?)(?=,\s*(?:update|condition):)/,
				);
				const updateMatch = update.match(
					/update:\s*((?:\([^)]*\)|\w+)\s*=>[\s\S]*?)(?=,?\s*}$)/,
				);

				if (targetMatch && argsMatch && updateMatch) {
					const target = targetMatch[1];
					const argsFn = argsMatch[1].trim();
					const updateFn = updateMatch[1].trim();

					if (conditionMatch) {
						const conditionFn = conditionMatch[1].trim();
						lines.push(
							`\t\t\t\tif ((${conditionFn})(params)) {`,
						);
						lines.push(`\t\t\t\t\tpatches.push(`);
						lines.push(`\t\t\t\t\t\tdispatch(`);
						lines.push(
							`\t\t\t\t\t\t\tapi.util.updateQueryData("${target}", (${argsFn})(params), (draft) => {`,
						);
						lines.push(
							`\t\t\t\t\t\t\t\t(${updateFn})(draft, params);`,
						);
						lines.push(`\t\t\t\t\t\t\t}),`);
						lines.push(`\t\t\t\t\t\t),`);
						lines.push(`\t\t\t\t\t);`);
						lines.push(`\t\t\t\t}`);
					} else {
						lines.push(`\t\t\t\tpatches.push(`);
						lines.push(`\t\t\t\t\tdispatch(`);
						lines.push(
							`\t\t\t\t\t\tapi.util.updateQueryData("${target}", (${argsFn})(params), (draft) => {`,
						);
						lines.push(
							`\t\t\t\t\t\t\t(${updateFn})(draft, params);`,
						);
						lines.push(`\t\t\t\t\t\t}),`);
						lines.push(`\t\t\t\t\t),`);
						lines.push(`\t\t\t\t);`);
					}
				}
			}
		}

		lines.push(
			`\t\t\t\ttry { await queryFulfilled; } catch { for (const p of patches) p.undo(); }`,
		);
		lines.push(`\t\t\t},`);
	}

	return lines.length > 0 ? lines : null;
}

function extractUpdatesArray(source: string): string[] | null {
	const match = source.match(/updates:\s*\[([\s\S]*)\]/);
	if (!match) return null;

	const content = match[1];
	const updates: string[] = [];
	let depth = 0;
	let current = "";

	for (const char of content) {
		if (char === "{") {
			depth++;
			current += char;
		} else if (char === "}") {
			depth--;
			current += char;
			if (depth === 0) {
				updates.push(current.trim());
				current = "";
			}
		} else if (depth > 0) {
			current += char;
		}
	}

	return updates.length > 0 ? updates : null;
}

function extractTagTypes(source: string | null, tags: Set<string>): void {
	if (!source) return;
	const matches = source.matchAll(/["'](\w+)["']/g);
	for (const m of matches) {
		if (m[1][0] === m[1][0].toUpperCase()) {
			tags.add(m[1]);
		}
	}
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function generateStoreTs(): string {
	return `// AUTO-GENERATED by ERTK codegen. Do not edit.
import { configureStore } from "@reduxjs/toolkit";
import { api } from "./api";

export const store = configureStore({
\treducer: {
\t\t[api.reducerPath]: api.reducer,
\t},
\tmiddleware: (getDefaultMiddleware) =>
\t\tgetDefaultMiddleware().concat(api.middleware),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
`;
}

function generateInvalidationTs(): string {
	return `// AUTO-GENERATED by ERTK codegen. Do not edit.
import { api } from "./api";

export function invalidateTags(
\t...args: Parameters<typeof api.util.invalidateTags>
) {
\treturn api.util.invalidateTags(...args);
}

export const updateQueryData = api.util.updateQueryData;
`;
}

function generateRouteFile(group: RouteGroup, config: ResolvedConfig): string {
	const lines: string[] = [];
	lines.push("// AUTO-GENERATED by ERTK codegen. Do not edit.");

	const handlerModule = config.routes!.handlerModule;

	const importLines: string[] = [];
	importLines.push(
		`import { createRouteHandler } from "${handlerModule}";`,
	);

	for (const [, ep] of group.methods) {
		const varName = `${ep.name}Endpoint`;
		importLines.push(`import ${varName} from "${ep.importPath}";`);
	}

	importLines.sort((a, b) => {
		const pathA = a.match(/from "(.+)"/)?.[1] ?? "";
		const pathB = b.match(/from "(.+)"/)?.[1] ?? "";
		return pathA.localeCompare(pathB);
	});

	lines.push(...importLines);
	lines.push("");

	for (const [method, ep] of group.methods) {
		const varName = `${ep.name}Endpoint`;
		lines.push(
			`export const ${method} = createRouteHandler(${varName});`,
		);
	}

	return lines.join("\n") + "\n";
}

// ─── Incremental Build Helpers ────────────────────────────────

function scanEndpointFiles(config: ResolvedConfig): string[] {
	if (!fs.existsSync(config.endpointsDir)) return [];
	const allFiles = fs.readdirSync(config.endpointsDir, {
		recursive: true,
	}) as string[];
	return allFiles
		.filter((f) => f.endsWith(".ts"))
		.map((f) => f.replace(/\\/g, "/"))
		.sort();
}

function hashFile(filePath: string): string {
	return crypto
		.createHash("md5")
		.update(fs.readFileSync(filePath))
		.digest("hex");
}

function loadManifest(config: ResolvedConfig): Record<string, string> {
	try {
		return JSON.parse(fs.readFileSync(config.manifestPath, "utf-8"));
	} catch {
		return {};
	}
}

function saveManifest(
	manifest: Record<string, string>,
	config: ResolvedConfig,
): void {
	fs.writeFileSync(
		config.manifestPath,
		JSON.stringify(manifest, null, 2) + "\n",
	);
}

function buildManifest(
	files: string[],
	config: ResolvedConfig,
): Record<string, string> {
	const manifest: Record<string, string> = {};
	for (const file of files) {
		manifest[file] = hashFile(path.join(config.endpointsDir, file));
	}
	return manifest;
}

function manifestsMatch(
	a: Record<string, string>,
	b: Record<string, string>,
): boolean {
	const keysA = Object.keys(a).sort();
	const keysB = Object.keys(b).sort();
	if (keysA.length !== keysB.length) return false;
	for (let i = 0; i < keysA.length; i++) {
		if (keysA[i] !== keysB[i]) return false;
		if (a[keysA[i]] !== b[keysB[i]]) return false;
	}
	return true;
}

function writeIfChanged(filePath: string, content: string): boolean {
	try {
		const existing = fs.readFileSync(filePath, "utf-8");
		if (existing === content) return false;
	} catch {
		// File doesn't exist yet
	}
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	return true;
}

function isIgnoredRoute(routeDir: string, config: ResolvedConfig): boolean {
	if (!config.routes) return true;
	const relative = path.relative(config.routes.dir, routeDir);
	const topLevel = relative.split(path.sep)[0];
	return config.routes.ignoredRoutes.has(topLevel);
}

// ─── Core Generate Function ──────────────────────────────────

function parseAllEndpoints(
	project: Project,
	config: ResolvedConfig,
): Map<string, ParsedEndpoint> {
	const files = scanEndpointFiles(config);
	const cache = new Map<string, ParsedEndpoint>();

	for (const file of files) {
		const parsed = parseEndpointFile(project, file, config);
		if (parsed) {
			cache.set(file, parsed);
		}
	}

	return cache;
}

function generate(
	endpoints: ParsedEndpoint[],
	config: ResolvedConfig,
): number {
	fs.mkdirSync(config.generatedDir, { recursive: true });

	// 1. Generate api.ts
	const apiContent = generateApiTs(endpoints, config);
	writeIfChanged(path.join(config.generatedDir, "api.ts"), apiContent);

	// 2. Generate store.ts
	writeIfChanged(
		path.join(config.generatedDir, "store.ts"),
		generateStoreTs(),
	);

	// 3. Generate invalidation.ts
	writeIfChanged(
		path.join(config.generatedDir, "invalidation.ts"),
		generateInvalidationTs(),
	);

	// 4. Generate route handlers (if routes config is present)
	let routeCount = 0;
	if (config.routes) {
		const routeGroups = groupEndpointsByRoute(endpoints, config);
		for (const [, group] of routeGroups) {
			if (isIgnoredRoute(group.appRouteDir, config)) continue;
			const routeContent = generateRouteFile(group, config);
			writeIfChanged(
				path.join(group.appRouteDir, "route.ts"),
				routeContent,
			);
			routeCount++;
		}
	}

	return routeCount;
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Run a one-shot generation. Skips if nothing changed (manifest comparison).
 */
export function runGenerate(config: ResolvedConfig): void {
	const tsProject = new Project({
		tsConfigFilePath: path.join(config.root, "tsconfig.json"),
		skipAddingFilesFromTsConfig: true,
	});

	const files = scanEndpointFiles(config);

	if (files.length === 0) {
		console.log("ERTK: No endpoint files found.");
		return;
	}

	const oldManifest = loadManifest(config);
	const newManifest = buildManifest(files, config);

	if (manifestsMatch(oldManifest, newManifest)) {
		console.log("ERTK: Nothing changed.");
		return;
	}

	const cache = parseAllEndpoints(tsProject, config);
	const routeCount = generate([...cache.values()], config);
	saveManifest(newManifest, config);

	const routeMsg = config.routes ? `, ${routeCount} routes` : "";
	console.log(`ERTK: Generated ${cache.size} endpoints${routeMsg}.`);
}

/**
 * Run generation in watch mode. Does an initial full build, then
 * watches for changes and incrementally regenerates.
 */
export function runWatch(config: ResolvedConfig): void {
	const tsProject = new Project({
		tsConfigFilePath: path.join(config.root, "tsconfig.json"),
		skipAddingFilesFromTsConfig: true,
	});

	const cache = parseAllEndpoints(tsProject, config);
	const routeCount = generate([...cache.values()], config);
	const manifest = buildManifest(scanEndpointFiles(config), config);
	saveManifest(manifest, config);

	const routeMsg = config.routes ? `, ${routeCount} routes ready` : "";
	console.log(
		`ERTK: Watching — ${cache.size} endpoints${routeMsg}.`,
	);

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	fs.watch(config.endpointsDir, { recursive: true }, (_event, filename) => {
		if (!filename?.endsWith(".ts")) return;
		if (debounceTimer) clearTimeout(debounceTimer);

		debounceTimer = setTimeout(() => {
			const relPath = filename.replace(/\\/g, "/");
			const fullPath = path.join(config.endpointsDir, relPath);

			if (fs.existsSync(fullPath)) {
				const hash = hashFile(fullPath);
				if (manifest[relPath] === hash) return;
				manifest[relPath] = hash;

				const existing = tsProject.getSourceFile(fullPath);
				if (existing) existing.forget();

				const parsed = parseEndpointFile(tsProject, relPath, config);
				if (parsed) {
					cache.set(relPath, parsed);
					console.log(`ERTK: Updated ${parsed.name}`);
				}
			} else {
				delete manifest[relPath];
				cache.delete(relPath);
				console.log(`ERTK: Removed ${relPath}`);
			}

			generate([...cache.values()], config);
			saveManifest(manifest, config);
		}, 300);
	});
}
