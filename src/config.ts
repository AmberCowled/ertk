import * as fs from "node:fs";
import * as path from "node:path";
import type { ErtkConfig, ResolvedConfig } from "./types.js";

const DEFAULT_CRUD_FILENAMES = [
	"get",
	"list",
	"create",
	"update",
	"delete",
	"send",
	"remove",
	"cancel",
];

/**
 * Helper for defining an ERTK config with type checking.
 */
export function defineConfig(config: ErtkConfig): ErtkConfig {
	return config;
}

/**
 * Load the ERTK config file from the project root.
 * Searches for ertk.config.ts, ertk.config.mts, ertk.config.js, ertk.config.mjs.
 */
export async function loadConfig(root: string): Promise<ErtkConfig> {
	const candidates = [
		"ertk.config.ts",
		"ertk.config.mts",
		"ertk.config.js",
		"ertk.config.mjs",
	];

	for (const filename of candidates) {
		const configPath = path.join(root, filename);
		if (fs.existsSync(configPath)) {
			try {
				const { createJiti } = await import("jiti");
				const jiti = createJiti(import.meta.url, {
					interopDefault: true,
				});
				const mod = await jiti.import(configPath);
				const config =
					(mod as { default?: ErtkConfig }).default ??
					(mod as ErtkConfig);
				return config;
			} catch {
				// If jiti fails, try native dynamic import (works for .mjs/.js)
				const mod = await import(configPath);
				return mod.default ?? mod;
			}
		}
	}

	// No config file found — use defaults
	return {};
}

/**
 * Auto-detect the path alias from tsconfig.json.
 * Looks for a paths entry like "@app/*": ["./src/*"] and extracts "@app".
 */
function detectPathAlias(root: string): { alias: string; aliasRoot: string } {
	const tsconfigPath = path.join(root, "tsconfig.json");
	if (!fs.existsSync(tsconfigPath)) {
		return { alias: "@app", aliasRoot: path.join(root, "src") };
	}

	try {
		const raw = fs.readFileSync(tsconfigPath, "utf-8");
		// Strip comments (// and /* */) for JSON parsing
		const stripped = raw
			.replace(/\/\/.*$/gm, "")
			.replace(/\/\*[\s\S]*?\*\//g, "");
		const tsconfig = JSON.parse(stripped);
		const paths = tsconfig.compilerOptions?.paths;

		if (paths) {
			for (const [pattern, targets] of Object.entries(paths)) {
				// Match patterns like "@app/*" → ["./src/*"]
				const aliasMatch = pattern.match(/^(@[\w-]+\/?\*?)$/);
				if (aliasMatch && Array.isArray(targets) && targets.length > 0) {
					const alias = pattern.replace("/*", "").replace("*", "");
					const targetPath = (targets as string[])[0]
						.replace("/*", "")
						.replace("*", "");
					const aliasRoot = path.resolve(root, targetPath);
					return { alias, aliasRoot };
				}
			}
		}
	} catch {
		// Fall through to defaults
	}

	return { alias: "@app", aliasRoot: path.join(root, "src") };
}

/**
 * Resolve user config + defaults into a fully resolved config
 * with absolute paths and all defaults applied.
 */
export function resolveConfig(root: string, config: ErtkConfig): ResolvedConfig {
	const { alias, aliasRoot } = config.pathAlias
		? {
				alias: config.pathAlias,
				aliasRoot: path.join(root, "src"),
			}
		: detectPathAlias(root);

	const endpointsDir = path.resolve(root, config.endpoints ?? "src/endpoints");
	const generatedDir = path.resolve(root, config.generated ?? "src/generated");

	return {
		root,
		endpointsDir,
		generatedDir,
		manifestPath: path.join(generatedDir, ".ertk-manifest.json"),
		pathAlias: alias,
		aliasRoot,
		baseUrl: config.baseUrl ?? "/api",
		baseQuery: config.baseQuery ?? null,
		crudFilenames: new Set(config.crudFilenames ?? DEFAULT_CRUD_FILENAMES),
		routes: config.routes
			? {
					dir: path.resolve(root, config.routes.dir),
					handlerModule: config.routes.handlerModule ?? "ertk/next",
					ignoredRoutes: new Set(config.routes.ignoredRoutes ?? []),
				}
			: null,
	};
}
