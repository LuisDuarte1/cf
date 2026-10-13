import { access, readFile, stat, utimes } from "node:fs/promises";
import path from "node:path";
import * as runtimeTypes from "@cloudflare/runtime-types";
import { runInTempDir, seed } from "@cloudflare/workers-utils/test-helpers";
import { http, HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { captureOutput } from "../helpers/capture-output.js";
import { server, setupMsw, TEST_BASE_URL } from "../helpers/msw.js";
import { runCf } from "../helpers/run-cf.js";

const RUNTIME_TYPES_MARKER = "// Begin mocked runtime types";
const TYPES_PATH = path.join(".cloudflare", "types", "index.d.ts");
const KEYS_PATH = path.join(".cloudflare", "types", "concurrency-keys.d.ts");
const ACCOUNT_ID = "023e105f4ecef8ad9ca31a8372d0c353";
const KEYS_URL = `${TEST_BASE_URL}/accounts/${ACCOUNT_ID}/workflows/concurrency`;

// Matches `@cloudflare/config`'s concurrency-keys test, which renders the same names for the
// Vite plugin. A difference makes `cf dev` and `cf workers types` rewrite each other's file.
const EXPECTED_KEYS = `/* eslint-disable */
// Generated from the concurrency keys of account 023e105f4ecef8ad9ca31a8372d0c353
declare namespace Cloudflare {
	interface GlobalProps {
		concurrencyKeys:
			| "back\\\\slash"
			| "naïve-ключ"
			| "payments-api"
			| "quote\\"d"
			| "warehouse-db";
	}
}
declare namespace CloudflareWorkersModule {
	export interface WorkflowStep {
		do<T extends Rpc.Serializable<T>>(
			name: string,
			config: WorkflowStepConfig & {
				concurrency:
					| Cloudflare.GlobalProps["concurrencyKeys"]
					| readonly Cloudflare.GlobalProps["concurrencyKeys"][];
			},
			callback: (ctx: WorkflowStepContext) => Promise<T>,
			rollbackOptions?: WorkflowStepRollbackOptions<T>
		): Promise<T>;
	}
}
`;

vi.mock("@cloudflare/runtime-types", () => ({
	RUNTIME_TYPES_MARKER: "// Begin mocked runtime types",
	generateRuntimeTypes: vi.fn(),
}));

function workerConfig(
	compatibilityDate = "2026-09-01",
	compatibilityFlags = ["nodejs_compat"]
): string {
	return `export default {
	worker: {
		name: "example-worker",
		compatibilityDate: ${JSON.stringify(compatibilityDate)},
		compatibilityFlags: ${JSON.stringify(compatibilityFlags)},
	},
};`;
}

describe("cf workers types", () => {
	runInTempDir();
	let output: ReturnType<typeof captureOutput>;

	beforeEach(() => {
		output = captureOutput();
		vi.clearAllMocks();
		vi.mocked(runtimeTypes.generateRuntimeTypes).mockResolvedValue({
			runtimeHeader: "// Runtime types header",
			runtimeTypes: "declare const runtimeBinding: Fetcher;\n",
			isCached: false,
		});
	});

	it("generates inferred and runtime types by default", async () => {
		await seed({ "cloudflare.config.ts": workerConfig() });

		await runCf(["workers", "types"]);

		expect(runtimeTypes.generateRuntimeTypes).toHaveBeenCalledWith({
			compatibilityDate: "2026-09-01",
			compatibilityFlags: ["nodejs_compat"],
			existingContent: undefined,
		});
		const generated = await readFile(TYPES_PATH, "utf8");
		expect(generated).toContain('import("cf/config").UnwrapConfig');
		expect(generated).toContain('import("../../cloudflare.config").default');
		expect(generated).toContain("// Runtime types header");
		expect(generated).toContain(RUNTIME_TYPES_MARKER);
		expect(generated).toContain("declare const runtimeBinding: Fetcher;");
		expect(JSON.parse(output.stdout())).toEqual({ path: TYPES_PATH });
	});

	it("omits runtime types when --include-runtime=false", async () => {
		await seed({ "cloudflare.config.ts": workerConfig() });

		await runCf(["workers", "types", "--include-runtime", "false"]);

		expect(runtimeTypes.generateRuntimeTypes).not.toHaveBeenCalled();
		const generated = await readFile(TYPES_PATH, "utf8");
		expect(generated).toContain('import("cf/config").UnwrapConfig');
		expect(generated).not.toContain(RUNTIME_TYPES_MARKER);
	});

	it("passes the existing declaration to the runtime-types cache", async () => {
		await seed({
			"cloudflare.config.ts": workerConfig(),
			[TYPES_PATH]: "existing declaration",
		});

		await runCf(["workers", "types"]);

		expect(runtimeTypes.generateRuntimeTypes).toHaveBeenCalledWith(
			expect.objectContaining({ existingContent: "existing declaration" })
		);
	});

	it("does not rewrite unchanged output", async () => {
		await seed({ "cloudflare.config.ts": workerConfig() });
		await runCf(["workers", "types"]);
		const unchangedTime = new Date("2020-01-01T00:00:00.000Z");
		await utimes(TYPES_PATH, unchangedTime, unchangedTime);

		await runCf(["workers", "types"]);

		expect((await stat(TYPES_PATH)).mtimeMs).toBe(unchangedTime.getTime());
	});

	it("uses --mode when evaluating function-form config", async () => {
		await seed({
			"cloudflare.config.ts": `export default ({ mode }) => ({
	worker: {
		name: "example-worker",
		compatibilityDate: mode === "staging" ? "2026-09-02" : "2026-09-01",
	},
});`,
		});

		await runCf(["workers", "types", "--mode", "staging"]);

		expect(runtimeTypes.generateRuntimeTypes).toHaveBeenCalledWith(
			expect.objectContaining({ compatibilityDate: "2026-09-02" })
		);
	});

	it("requires cloudflare.config.ts", async () => {
		await expect(runCf(["workers", "types"])).rejects.toThrow(
			"cloudflare.config.ts is required by cf workers types."
		);
	});

	it("requires a Worker definition", async () => {
		await seed({ "cloudflare.config.ts": "export default {};" });

		await expect(runCf(["workers", "types"])).rejects.toThrow(
			"cloudflare.config.ts must define a Worker to generate types."
		);
	});

	it("rejects --local", async () => {
		await expect(runCf(["workers", "types", "--local"])).rejects.toThrow(
			"--local is not supported by cf workers types."
		);
	});
});

function workflowConfig(
	options: { accountId?: string; workflow?: boolean } = {}
): string {
	const { accountId = ACCOUNT_ID, workflow = true } = options;
	return `export default {
	${accountId === "" ? "" : `accountId: ${JSON.stringify(accountId)},`}
	worker: {
		name: "example-worker",
		compatibilityDate: "2026-09-01",
		exports: ${
			workflow
				? `{ OrderWorkflow: { type: "workflow", name: "order-workflow" } }`
				: `{ default: { type: "worker" } }`
		},
	},
};`;
}

function listPage(
	names: string[],
	resultInfo = { total_count: names.length, total_pages: 1 }
) {
	return HttpResponse.json({
		success: true,
		errors: [],
		messages: [],
		result: names.map((name) => ({ id: name, name, limit: 1 })),
		result_info: { count: names.length, page: 1, per_page: 100, ...resultInfo },
	});
}

async function exists(file: string): Promise<boolean> {
	return access(file).then(
		() => true,
		() => false
	);
}

describe("cf workers types concurrency keys", () => {
	runInTempDir();
	setupMsw();
	let output: ReturnType<typeof captureOutput>;
	let requests: URL[];

	const ENV = {
		CLOUDFLARE_API_TOKEN: "test-token",
		CLOUDFLARE_API_BASE_URL: TEST_BASE_URL,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		output = captureOutput();
		requests = [];
		vi.mocked(runtimeTypes.generateRuntimeTypes).mockResolvedValue({
			runtimeHeader: "// Runtime types header",
			runtimeTypes: "declare const runtimeBinding: Fetcher;\n",
			isCached: false,
		});
	});

	function serveKeys(...pages: (() => Response)[]) {
		server.use(
			http.get(KEYS_URL, ({ request }) => {
				const url = new URL(request.url);
				requests.push(url);
				const page = pages[Number(url.searchParams.get("page")) - 1];
				return page ? page() : HttpResponse.json({}, { status: 500 });
			})
		);
	}

	it("writes the configured account's keys next to index.d.ts", async () => {
		await seed({ "cloudflare.config.ts": workflowConfig() });
		serveKeys(() =>
			listPage([
				"warehouse-db",
				"payments-api",
				'quote"d',
				"back\\slash",
				"naïve-ключ",
			])
		);

		await runCf(["workers", "types"], ENV);

		expect(await readFile(KEYS_PATH, "utf8")).toBe(EXPECTED_KEYS);
		expect(requests[0]?.searchParams.get("per_page")).toBe("100");
		expect(JSON.parse(output.stdout())).toEqual({
			path: TYPES_PATH,
			concurrencyKeys: { path: KEYS_PATH, status: "written" },
		});
	});

	it("follows every page", async () => {
		await seed({ "cloudflare.config.ts": workflowConfig() });
		const names = Array.from({ length: 150 }, (_, i) => `key-${i}`);
		const info = { total_count: 150, total_pages: 2 };
		serveKeys(
			() => listPage(names.slice(0, 100), info),
			() => listPage(names.slice(100), info)
		);

		await runCf(["workers", "types"], ENV);

		expect(requests.map((url) => url.searchParams.get("page"))).toEqual([
			"1",
			"2",
		]);
		expect(await readFile(KEYS_PATH, "utf8")).toContain('| "key-149"');
	});

	it.for([
		{ name: "no accountId", config: workflowConfig({ accountId: "" }) },
		{ name: "no Workflow export", config: workflowConfig({ workflow: false }) },
	])(
		"skips the lookup with $name and removes stale keys",
		async ({ config }) => {
			await seed({ "cloudflare.config.ts": config, [KEYS_PATH]: "stale" });
			serveKeys(() => listPage(["payments-api"]));

			await runCf(["workers", "types"], ENV);

			expect(requests).toEqual([]);
			expect(await exists(KEYS_PATH)).toBe(false);
			expect(JSON.parse(output.stdout())).toEqual({ path: TYPES_PATH });
		}
	);

	it("ignores CLOUDFLARE_ACCOUNT_ID when the config pins no account", async () => {
		await seed({ "cloudflare.config.ts": workflowConfig({ accountId: "" }) });
		serveKeys(() => listPage(["payments-api"]));

		await runCf(["workers", "types"], {
			...ENV,
			CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
		});

		expect(requests).toEqual([]);
	});

	it("removes stale keys with --no-concurrency-keys", async () => {
		await seed({
			"cloudflare.config.ts": workflowConfig(),
			[KEYS_PATH]: "stale",
		});
		serveKeys(() => listPage(["payments-api"]));

		await runCf(["workers", "types", "--no-concurrency-keys"], ENV);

		expect(requests).toEqual([]);
		expect(await exists(KEYS_PATH)).toBe(false);
	});

	it("removes the keys file when the account has no keys", async () => {
		await seed({
			"cloudflare.config.ts": workflowConfig(),
			[KEYS_PATH]: "stale",
		});
		serveKeys(() => listPage([]));

		await runCf(["workers", "types"], ENV);

		expect(await exists(KEYS_PATH)).toBe(false);
		expect(JSON.parse(output.stdout()).concurrencyKeys.status).toBe("removed");
	});

	it.for([
		{
			name: "a failed request",
			page: () =>
				HttpResponse.json(
					{
						success: false,
						errors: [{ code: 10800, message: "user.feature_disabled" }],
					},
					{ status: 403 }
				),
		},
		{
			name: "a short listing",
			page: () => listPage(["a"], { total_count: 2, total_pages: 1 }),
		},
	])("keeps the previous keys after $name", async ({ page }) => {
		await seed({
			"cloudflare.config.ts": workflowConfig(),
			[KEYS_PATH]: "previous",
		});
		serveKeys(page);

		const { exitCode } = await runCf(["workers", "types"], ENV);

		expect(exitCode).toBe(0);
		expect(await readFile(KEYS_PATH, "utf8")).toBe("previous");
		expect(output.stderr()).toContain(
			"Kept the previous concurrency key types"
		);
		expect(JSON.parse(output.stdout()).concurrencyKeys.status).toBe("kept");
	});

	it("keeps the previous keys without credentials and never starts a login", async () => {
		await seed({
			"cloudflare.config.ts": workflowConfig(),
			[KEYS_PATH]: "previous",
		});
		serveKeys(() => listPage(["payments-api"]));

		const { exitCode } = await runCf(["workers", "types"], {
			CLOUDFLARE_API_BASE_URL: TEST_BASE_URL,
			CLOUDFLARE_API_TOKEN: undefined,
		});

		expect(exitCode).toBe(0);
		expect(requests).toEqual([]);
		expect(await readFile(KEYS_PATH, "utf8")).toBe("previous");
		expect(output.stderr()).toContain("No authentication token found");
	});

	it("does not rewrite unchanged keys", async () => {
		await seed({ "cloudflare.config.ts": workflowConfig() });
		serveKeys(
			() => listPage(["payments-api"]),
			() => listPage(["payments-api"])
		);
		await runCf(["workers", "types"], ENV);
		const unchangedTime = new Date("2020-01-01T00:00:00.000Z");
		await utimes(KEYS_PATH, unchangedTime, unchangedTime);
		server.resetHandlers();
		serveKeys(() => listPage(["payments-api"]));

		await runCf(["workers", "types"], ENV);

		expect((await stat(KEYS_PATH)).mtimeMs).toBe(unchangedTime.getTime());
	});

	it("uses the accountId of the selected mode", async () => {
		await seed({
			"cloudflare.config.ts": `export default ({ mode }) => ({
	accountId: mode === "staging" ? "staging-account" : ${JSON.stringify(ACCOUNT_ID)},
	worker: {
		name: "example-worker",
		compatibilityDate: "2026-09-01",
		exports: { OrderWorkflow: { type: "workflow", name: "order-workflow" } },
	},
});`,
		});
		const urls: string[] = [];
		server.use(
			http.get(
				`${TEST_BASE_URL}/accounts/:account/workflows/concurrency`,
				({ request }) => {
					urls.push(new URL(request.url).pathname);
					return listPage(["payments-api"]);
				}
			)
		);

		await runCf(["workers", "types", "--mode", "staging"], ENV);

		expect(urls).toEqual([
			"/client/v4/accounts/staging-account/workflows/concurrency",
		]);
	});
});
