/**
 * Schema pieces for Feishu/Lark OpenAPI responses. Feishu sends `null`, not an absent field, for values it withholds or has
 * none of (an ID without its scope, a deleted message's body, the last page's `page_token`), and zod's `.optional()` and
 * `.default()` refuse `null`. These read `null` as absent, so callers keep seeing `undefined`, `''`, `false` or `[]`.
 * Identity fields (message, chat and member IDs, create_time) stay required: an item without them is skipped, not guessed.
 */
import { z } from 'zod'

/** `null` or absent → `undefined`. */
export const absent = <T extends z.ZodType>(schema: T) => schema.nullish().transform(value => value ?? undefined).optional()
/** `null` or absent → `''`. */
export const textOr = z.string().nullish().transform(value => value ?? '')
/** `null` or absent → `false`. */
export const flagOr = z.boolean().nullish().transform(value => value ?? false)
/** `null` or absent → `[]`. */
export const listOf = <T extends z.ZodType>(item: T) => z.array(item).nullish().transform(value => value ?? [])
