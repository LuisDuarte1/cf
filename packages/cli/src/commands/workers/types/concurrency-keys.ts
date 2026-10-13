import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getCloudflareApiBaseUrl } from "@cloudflare/workers-utils/compliance";
import type { ParsedInputConfig } from "@cloudflare/config";
import {
	createCloudflareClientWithToken,
	getAuthToken,
	getComplianceRegion,
} from "#lib/auth.js";
import { getDefaultHeaders } from "#lib/request-headers.js";
import listConcurrencyKeys from "#operations/workflows/concurrency/list.js";

/** Sibling of `index.d.ts`: `cf dev` and builds rewrite that file without fetching anything.
 * The format matches `@cloudflare/config`'s `renderConcurrencyKeyTypes`, which the Vite plugin uses. */
export const CONCURRENCY_KEY_TYPES_PATH = path.join(
	".cloudflare",
	"types",
	"concurrency-keys.d.ts"
);

const PER_PAGE = 100;
const MAX_PAGES = 100; // 10,000 keys; bounds a misbehaving pager
const FETCH_TIMEOUT_MS = 5_000;

export type ConcurrencyKeyTypesResult =
	| { status: "written" | "unchanged" | "removed"; path: string }
	| { status: "kept"; path: string; reason: string };

interface ListPage {
	result: { name: string }[];
	result_info?: { total_count?: number; total_pages?: number };
}

/** Writes the account's concurrency key names when the Worker defines a Workflow and the config
 * pins `accountId`. Returns `undefined` when that gate is closed, after removing a stale file. */
export async function syncConcurrencyKeyTypes(options: {
	projectRoot: string;
	config: ParsedInputConfig;
	enabled: boolean;
}): Promise<ConcurrencyKeyTypesResult | undefined> {
	const outputPath = path.join(options.projectRoot, CONCURRENCY_KEY_TYPES_PATH);
	const { accountId, worker } = options.config;
	const definesWorkflow = Object.values(worker?.exports ?? {}).some(
		(value) => value.type === "workflow"
	);
	if (!options.enabled || accountId === undefined || !definesWorkflow) {
		await fsp.rm(outputPath, { force: true });
		return undefined;
	}

	let names: string[];
	try {
		names = await listConcurrencyKeyNames(accountId);
	} catch (error) {
		return {
			status: "kept",
			path: outputPath,
			reason: (error instanceof Error ? error.message : String(error)).split(
				"\n"
			)[0] as string,
		};
	}

	const content = renderConcurrencyKeyTypes(accountId, names);
	if (content === undefined) {
		await fsp.rm(outputPath, { force: true });
		return { status: "removed", path: outputPath };
	}
	const existing = await fsp
		.readFile(outputPath, "utf8")
		.catch(() => undefined);
	if (existing === content) {
		return { status: "unchanged", path: outputPath };
	}
	await fsp.mkdir(path.dirname(outputPath), { recursive: true });
	await fsp.writeFile(outputPath, content);
	return { status: "written", path: outputPath };
}

async function listConcurrencyKeyNames(accountId: string): Promise<string[]> {
	const client = createCloudflareClientWithToken({
		apiToken: await getAuthToken(),
		baseURL: getCloudflareApiBaseUrl({
			compliance_region: await getComplianceRegion(),
		}),
		defaultHeaders: getDefaultHeaders(),
	});
	const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const names: string[] = [];
	let totalCount = 0;
	for (let page = 1; page <= MAX_PAGES; page++) {
		const response = (await client.send(
			listConcurrencyKeys,
			{ account_id: accountId, page, per_page: PER_PAGE },
			{ abortSignal: signal, maxRetries: 0 }
		)) as ListPage;
		names.push(...response.result.map((key) => key.name));
		totalCount = response.result_info?.total_count ?? names.length;
		if (page >= (response.result_info?.total_pages ?? page)) {
			break;
		}
	}
	if (names.length !== totalCount) {
		throw new Error(
			`Listing concurrency keys returned ${names.length} of ${totalCount} keys`
		);
	}
	return names;
}

/** Sorted, JSON-escaped names, so the output is stable and valid for any key name.
 * No keys leaves the property undeclared, which keeps key names typed as `string`. */
export function renderConcurrencyKeyTypes(
	accountId: string,
	names: readonly string[]
): string | undefined {
	if (names.length === 0) {
		return undefined;
	}
	const literals = [...new Set(names)]
		.sort()
		.map((name) => JSON.stringify(name));
	const union =
		literals.length === 1
			? ` ${literals[0]};`
			: `\n${literals.map((literal) => `\t\t\t| ${literal}`).join("\n")};`;
	return [
		"/* eslint-disable */",
		`// Generated from the concurrency keys of account ${accountId}`,
		"declare namespace Cloudflare {",
		"\tinterface GlobalProps {",
		`\t\tconcurrencyKeys:${union}`,
		"\t}",
		"}",
		...INTERNAL_PREVIEW_STEP_OVERLOAD,
		"",
	].join("\n");
}

// Internal preview only: runtime types from released workerd lack `WorkflowStepConfig.concurrency`.
// The overload requires `concurrency`, so it only matches keyed steps and is inert once workerd ships it.
const INTERNAL_PREVIEW_STEP_OVERLOAD = [
	"declare namespace CloudflareWorkersModule {",
	"\texport interface WorkflowStep {",
	"\t\tdo<T extends Rpc.Serializable<T>>(",
	"\t\t\tname: string,",
	"\t\t\tconfig: WorkflowStepConfig & {",
	"\t\t\t\tconcurrency:",
	'\t\t\t\t\t| Cloudflare.GlobalProps["concurrencyKeys"]',
	'\t\t\t\t\t| readonly Cloudflare.GlobalProps["concurrencyKeys"][];',
	"\t\t\t},",
	"\t\t\tcallback: (ctx: WorkflowStepContext) => Promise<T>,",
	"\t\t\trollbackOptions?: WorkflowStepRollbackOptions<T>",
	"\t\t): Promise<T>;",
	"\t}",
	"}",
];
