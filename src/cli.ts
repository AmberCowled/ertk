#!/usr/bin/env node

import * as path from "node:path";
import { loadConfig, resolveConfig } from "./config.js";
import { runGenerate, runWatch } from "./generate.js";

const HELP = `
ertk — Easy RTK Query codegen

Usage:
  ertk generate          One-shot generation (skips if nothing changed)
  ertk generate --watch  Watch mode with incremental regeneration
  ertk init              Scaffold config file and directories
  ertk --help            Show this help message

Options:
  --watch    Watch for endpoint file changes and regenerate
  --help     Show help
`.trim();

async function main() {
	const args = process.argv.slice(2);
	const command = args[0];

	if (!command || command === "--help" || command === "-h") {
		console.log(HELP);
		process.exit(0);
	}

	if (command === "init") {
		await runInit();
		return;
	}

	if (command === "generate") {
		const root = process.cwd();
		const userConfig = await loadConfig(root);
		const config = resolveConfig(root, userConfig);
		const isWatch = args.includes("--watch");

		if (isWatch) {
			runWatch(config);
		} else {
			runGenerate(config);
		}
		return;
	}

	console.error(`Unknown command: ${command}`);
	console.log(HELP);
	process.exit(1);
}

async function runInit() {
	const fs = await import("node:fs");
	const root = process.cwd();

	// Create config file
	const configPath = path.join(root, "ertk.config.ts");
	if (fs.existsSync(configPath)) {
		console.log("ertk.config.ts already exists, skipping.");
	} else {
		fs.writeFileSync(
			configPath,
			`import { defineConfig } from "ertk";

export default defineConfig({
\t// Directory containing endpoint definition files
\tendpoints: "src/endpoints",

\t// Directory for generated output (api.ts, store.ts, invalidation.ts)
\tgenerated: "src/generated",

\t// Base URL for RTK Query fetchBaseQuery
\tbaseUrl: "/api",

\t// Route generation (remove to skip route generation for client-only projects)
\troutes: {
\t\tdir: "src/app/api",
\t\thandlerModule: "ertk/next",
\t\tignoredRoutes: [],
\t},
});
`,
		);
		console.log("Created ertk.config.ts");
	}

	// Create directories
	const dirs = ["src/endpoints", "src/generated"];
	for (const dir of dirs) {
		const fullPath = path.join(root, dir);
		if (!fs.existsSync(fullPath)) {
			fs.mkdirSync(fullPath, { recursive: true });
			console.log(`Created ${dir}/`);
		}
	}

	console.log("\nDone! Define your first endpoint in src/endpoints/ and run:");
	console.log("  npx ertk generate");
}

main().catch((err) => {
	console.error("ERTK Error:", err);
	process.exit(1);
});
