/**
 * dshsa: the AWS replacements for DSH's `Deployment` (accounts resolved by setup) and `Commands` (gh / lark-cli subprocesses).
 * The host (`packages/cell`) builds them from the cell record and Secrets Manager; `packages/sources` implements the API clients.
 */
import type { z } from 'zod'

/** What a cell knows about its repository, its GitHub App identity and its tenant's Feishu bot (DSH `Deployment`). */
export interface CellInfo {
  tenantId: string
  cellId: string
  /** `owner/name`, canonical as GitHub returns it. */
  repository: string
  repoId: number
  installationId: number
  defaultBranch: string
  /** The platform GitHub App: mentions match `@slug`; the agent's own comments are by `login` (`<slug>[bot]`). */
  app: { slug: string; login: string; userId: number; noreply: string }
  /** The tenant's Feishu/Lark bot, when the tenant has one. */
  feishu?: { domain: 'feishu' | 'lark'; appId: string; botId: string; name: string }
}

/** A failed GitHub REST call; `status` takes the role of DSH's `CliError.code` (the HTTP status). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
/** A failed Feishu OpenAPI call; `code` is Feishu's business error code, as DSH's `CliError.code` was. */
export class FeishuError extends Error {
  constructor(message: string, readonly code: number) { super(message) }
}
export interface ApiInit { method?: string; body?: unknown; headers?: Record<string, string> }
/** GitHub REST client acting as the App installation, restricted to the cell's repository (paths are relative to `repos/<repo>/`). */
export interface GithubApi {
  request<T>(schema: z.ZodType<T>, path: string, init?: ApiInit): Promise<T>
  /** Every page of a list; items failing `schema` are skipped and counted in `tally.skipped`. */
  pages<T>(schema: z.ZodType<T>, path: string, tally?: { skipped: number }): Promise<T[]>
  /** The raw response, such as for ETag polling (a 304 is returned, not thrown). */
  raw(path: string, init?: ApiInit): Promise<{ status: number; headers: Record<string, string>; body: string }>
}
/** Feishu/Lark OpenAPI client with the tenant's `tenant_access_token` (bot identity only). */
export interface FeishuApi {
  request<T>(schema: z.ZodType<T>, method: string, path: string, init?: { params?: Record<string, string>; data?: unknown }): Promise<T>
  /** Downloads a message resource (image or file), refusing more than `maxBytes`. */
  download?(path: string, params?: Record<string, string>, maxBytes?: number): Promise<{ data: Buffer; contentType: string }>
}
export interface SourceApis { github: GithubApi; feishu?: FeishuApi }
/** An image read for a stateless assessment (DSH attached it to an Agent instead). */
export interface ImageAttachment { mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string /* base64 */ }
