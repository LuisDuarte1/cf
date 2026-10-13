---
"cf": minor
---

Type Workflow step concurrency keys in `cf workers types`

When the Worker exports a Workflow and `cloudflare.config.ts` sets `accountId`, `cf workers types` lists that account's concurrency keys into `.cloudflare/types/concurrency-keys.d.ts`, so a misspelled `concurrency` key in `step.do` fails type checking instead of running without a limit. The lookup never prompts; without credentials or on a failed request the previous key types are kept. Pass `--no-concurrency-keys` to skip it.
