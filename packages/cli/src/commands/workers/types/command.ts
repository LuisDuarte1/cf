import * as path from "node:path";
import { syncConcurrencyKeyTypes } from "./concurrency-keys.js";
import { loadWorkerTypesConfig, writeWorkerTypes } from "./generate.js";
import type { CommonYargsOptions, InferArgs } from "#lib/cli-types.js";
import type { Argv, CommandModule } from "yargs";
import { formatOutput } from "#lib/output.js";
import {
	CLOUDFLARE_CONFIG_FILENAME,
	findCloudflareConfig,
} from "#lib/project-settings.js";
import { hint } from "#lib/ui/format.js";

function builder(yargs: Argv<CommonYargsOptions>) {
	return yargs
		.option("include-runtime", {
			type: "boolean",
			description: "Include Cloudflare Workers runtime types",
			default: true,
		})
		.option("concurrency-keys", {
			type: "boolean",
			description:
				"Type Workflow step concurrency keys from the account in accountId (requires a Workflow export)",
			default: true,
		});
}

type TypesArgs = InferArgs<typeof builder>;

const command: CommandModule<CommonYargsOptions, TypesArgs> = {
	command: "types",
	describe: "Generate types from cloudflare.config.ts",
	builder,
	handler: async (argv) => {
		if (argv.local) {
			throw new Error("--local is not supported by cf workers types.");
		}

		const configPath = findCloudflareConfig();
		if (configPath === null) {
			throw new Error(
				`${CLOUDFLARE_CONFIG_FILENAME} is required by cf workers types.`
			);
		}

		const config = await loadWorkerTypesConfig(configPath, argv.mode);
		const outputPath = await writeWorkerTypes({
			configPath,
			config,
			includeRuntime: argv.includeRuntime,
		});
		const keys = await syncConcurrencyKeyTypes({
			projectRoot: path.dirname(configPath),
			config,
			enabled: argv.concurrencyKeys,
		});
		if (keys?.status === "kept" && !argv.quiet) {
			process.stderr.write(
				`${hint(`Kept the previous concurrency key types: ${keys.reason}`)}\n`
			);
		}

		formatOutput(
			{
				path: path.relative(process.cwd(), outputPath),
				...(keys && {
					concurrencyKeys: {
						path: path.relative(process.cwd(), keys.path),
						status: keys.status,
					},
				}),
			},
			{ quiet: argv.quiet }
		);
	},
};

export default command;
