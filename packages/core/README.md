# @dshsa/core

The DSH domain core, copied **verbatim** from `dsh-superagent-prototype/` (MIT License, Copyright (c) 2026 DeepSeek Harness Team; see `LICENSE`).

| Here | Source | Change |
|---|---|---|
| `src/core/*.ts` | `src/core/*.ts` | none |
| `src/policy.ts`, `src/limits.ts`, `src/admission.ts` | same paths | none |
| `src/infra/text.ts` | `src/infra/text.ts` | none |
| `src/infra/environment.ts` | `src/infra/environment.ts` | **adapter**: only `WORKER_COMMANDS` |
| `tests/core-engine.spec.ts`, `tests/stage.spec.ts` | `tests/` | none |

The directory layout matches DSH so relative imports (and the tests) stay unchanged. Do not edit the copied files; put AWS-specific behaviour in adapters (`packages/cell`, `packages/sources`).

Exports point at TypeScript sources. The core uses parameter properties, so run it through vitest or a bundler (esbuild/tsdown), not Node's type stripping.
