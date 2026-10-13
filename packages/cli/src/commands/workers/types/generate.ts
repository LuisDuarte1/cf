import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { generateTypes, loadAndParseConfig } from "@cloudflare/config";
import {
	generateRuntimeTypes,
	RUNTIME_TYPES_MARKER,
} from "@cloudflare/runtime-types";
import type { ParsedInputConfig } from "@cloudflare/config";
import { CLOUDFLARE_CONFIG_FILENAME } from "#lib/project-settings.js";

export const TYPES_OUTPUT_PATH = path.join(
	".cloudflare",
	"types",
	"index.d.ts"
);

export interface GenerateWorkerTypesOptions {
	configPath: string;
	mode: string | undefined;
	includeRuntime: boolean;
}

function formatConfigIssues(
	issues: { path: PropertyKey[]; message: string }[]
) {
	return issues
		.map((issue) => {
			const issuePath = issue.path
				.filter((segment) => typeof segment !== "symbol")
				.join(".");
			return `  - ${issuePath ? `${issuePath}: ` : ""}${issue.message}`;
		})
		.join("\n");
}

function importPath(fromDirectory: string, target: string): string {
	const relativePath = path
		.relative(fromDirectory, target)
		.split(path.sep)
		.join("/");
	return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

/**
 * Writes `.cloudflare/types/index.d.ts` next to `configPath` and returns its
 * absolute path. Shared by `cf workers types` and the `cf init` scaffold.
 */
export async function generateWorkerTypes(
	options: GenerateWorkerTypesOptions
): Promise<string> {
	const config = await loadWorkerTypesConfig(options.configPath, options.mode);
	return writeWorkerTypes({ ...options, config });
}

/** Evaluates and validates the config once, so `cf workers types` can reuse it for key types.
 * Throws when the config is invalid or defines no Worker. */
export async function loadWorkerTypesConfig(
	configPath: string,
	mode: string | undefined
): Promise<WorkerTypesConfig> {
	const loaded = await loadAndParseConfig(configPath, {
		isPreview: false,
		mode,
	});
	if (!loaded.result.success) {
		throw new Error(
			`Invalid ${CLOUDFLARE_CONFIG_FILENAME}:\n${formatConfigIssues(loaded.result.error.issues)}`
		);
	}

	const config = loaded.result.data;
	if (config.worker === undefined) {
		throw new Error(
			`${CLOUDFLARE_CONFIG_FILENAME} must define a Worker to generate types.`
		);
	}
	return config as WorkerTypesConfig;
}

export type WorkerTypesConfig = ParsedInputConfig & {
	worker: NonNullable<ParsedInputConfig["worker"]>;
};

/** Writes `index.d.ts` from an already loaded config and returns its absolute path.
 * Lets `cf workers types` evaluate the config once for both index and key types. */
export async function writeWorkerTypes(
	options: Omit<GenerateWorkerTypesOptions, "mode"> & {
		config: WorkerTypesConfig;
	}
): Promise<string> {
	const { configPath } = options;
	const worker = options.config.worker;

	const projectRoot = path.dirname(configPath);
	const outputPath = path.join(projectRoot, TYPES_OUTPUT_PATH);
	let existingContent: string | undefined;
	try {
		existingContent = await fsp.readFile(outputPath, "utf8");
	} catch {
		// The output does not exist yet.
	}

	let content = generateTypes({
		configPath: importPath(path.dirname(outputPath), configPath),
		packageName: "cf/config",
	});
	if (options.includeRuntime) {
		const { runtimeHeader, runtimeTypes } = await generateRuntimeTypes({
			compatibilityDate: worker.compatibilityDate,
			compatibilityFlags: worker.compatibilityFlags ?? [],
			existingContent,
		});
		content += `\n${runtimeHeader}\n${RUNTIME_TYPES_MARKER}\n${runtimeTypes}`;
	}

	if (existingContent !== content) {
		await fsp.mkdir(path.dirname(outputPath), { recursive: true });
		await fsp.writeFile(outputPath, content);
	}
	return outputPath;
}
