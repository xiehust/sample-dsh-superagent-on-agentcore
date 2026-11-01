/**
 * dshsa: the decision schemas of DSH's main-Session tools, copied verbatim: `orchestrator_route` (src/app/tools/main.ts),
 * `orchestrator_eval_decide`'s AssessmentSchema (src/app/assessment.ts) and AcknowledgementSchema (src/app/tools/tool.ts).
 * The stateless Assessor forces the model to call one of them, so a decision has exactly the shape the DSH router produced.
 */
import { z } from 'zod'
import { IM_WORDS, NOTE_WORDS, wordCount } from './infra/text.ts'
import { AdmissionDirectionSchema, RuleAssessmentSchema, directionAllowed } from './policy.ts'

/** Human-facing acknowledgement text, constrained to `IM_WORDS` regardless of which channel it is posted to. */
export const AcknowledgementSchema = z.string().trim().min(1)
  .refine(text => wordCount(text) <= IM_WORDS, `An acknowledgement has at most ${IM_WORDS} words (Chinese uses word segmentation); write one short sentence.`)
export const WorktreeNameSchema = z.string().max(32).regex(/^[a-z]+(?:-[a-z0-9]+){0,3}$/, 'Use 1–4 short English words in lowercase kebab-case, at most 32 characters').describe('Meaningful short English ticket name, e.g. fix-plan-color. Translate Chinese titles into English; no Chinese, pinyin or generic ticket names. 1–4 lowercase words in kebab-case, at most 32 characters.')
/** Schema for the main Session's proactive candidate assessment decision (`orchestrator_eval_decide`). */
export const AssessmentSchema = z.object({
  decision: z.enum(['accept', 'ignore', 'unavailable']),
  rule_assessments: z.array(RuleAssessmentSchema)
    .refine(assessments => new Set(assessments.map(assessment => assessment.rule_id)).size === assessments.length,
      'Duplicate rule assessment IDs').describe('One per enabled rule.'),
  direction: AdmissionDirectionSchema.describe('Required for every decision.'),
  title: z.string().min(1).max(160),
  worktree_name: WorktreeNameSchema.optional(),
  scope: z.string().max(1500),
  intent_evidence: z.string().trim().min(1).max(700).nullish().describe('For acceptance: the quotes that establish the three facts.'),
  acknowledgement: AcknowledgementSchema.nullish().describe('For acceptance: one sentence in the source language, posted as a reply to the trigger; omit only when a matched rule asks for silence.'),
  reason: z.string().min(1).max(500),
}).strict().refine(value => value.decision !== 'accept' || !directionAllowed(value.direction) || !value.rule_assessments.some(rule => rule.matched)
  || !!value.worktree_name, { message: 'Accepted work requires a short English worktree_name', path: ['worktree_name'] })

const RoutingNoteSchema = z.string().trim()
  .refine(text => wordCount(text) <= NOTE_WORDS, `Routing note must not exceed ${NOTE_WORDS} words (Chinese uses word segmentation). Shorten it; do not split it across deliveries.`)
  .describe(`Optional routing background or explicit human constraint, at most ${NOTE_WORDS} words. Never add implementation instructions or replace the original source.`)
/**
 * One routing decision of `orchestrator_route`. The schema holds only its shape: each kind's fields are checked as its item
 * runs (`FIELDS`), so an item that lacks one, or whose value breaks a limit, is refused alone.
 */
const RouteItemSchema = z.object({
  kind: z.enum(['accept', 'attach', 'ignore', 'stop']),
  trigger_id: z.string().describe('The candidate card\'s trigger_id; deciding it decides its batch.'),
  ticket_id: z.string().nullish().describe('attach and stop: the ticket.'),
  title: z.string().nullish().describe('accept: a short label of at most 200 characters describing the original request; no added requirements or implementation advice.'),
  worktree_name: z.string().nullish().describe(`accept: ${WorktreeNameSchema.description ?? ''}`),
  acknowledgement: z.string().nullish().describe(`accept: one brief sentence of at most ${IM_WORDS} words naming the concrete change and intended result in the source language. It is posted as a reply to the original source on acceptance, so do not quote the source; quote an earlier proposal briefly only when the trigger merely confirms it and the sentence does not already state it. No generic I will handle it.`),
  note: z.string().nullish().describe(`accept and attach: ${RoutingNoteSchema.description ?? ''}`),
  reason: z.string().nullish().describe('ignore and stop: why, at most 500 characters; an ignore needs it.'),
}).strict()
type RouteItem = z.infer<typeof RouteItemSchema>
type Kind = RouteItem['kind']
type Field = Exclude<keyof RouteItem, 'kind' | 'trigger_id'>
/** Each field's check, the kinds whose items read it and those that need it; an item of another kind leaves it unread. */
const FIELDS: Record<Field, { check: z.ZodType; reads: readonly Kind[]; needs: readonly Kind[] }> = {
  ticket_id: { check: z.string(), reads: ['attach', 'stop'], needs: ['attach', 'stop'] },
  title: { check: z.string().max(200), reads: ['accept'], needs: ['accept'] },
  worktree_name: { check: WorktreeNameSchema, reads: ['accept'], needs: ['accept'] },
  acknowledgement: { check: AcknowledgementSchema, reads: ['accept'], needs: ['accept'] },
  note: { check: RoutingNoteSchema, reads: ['accept', 'attach'], needs: [] },
  reason: { check: z.string().max(500), reads: ['ignore', 'stop'], needs: ['ignore'] },
}
/** Why an item cannot run: a field its kind needs is missing, or one it reads breaks its limit. */
function invalid(item: RouteItem): string | undefined {
  for (const [field, { check, reads, needs }] of Object.entries(FIELDS) as [Field, typeof FIELDS[Field]][]) {
    const value = item[field]
    if (!reads.includes(item.kind)) continue
    if (value === undefined || value === null || value.trim() === '') {
      if (needs.includes(item.kind)) return `${item.kind} needs ${field}`
      continue
    }
    const checked = check.safeParse(value)
    if (!checked.success) return `${field}: ${checked.error.issues[0]?.message ?? 'invalid'}`
  }
  return undefined
}
export { RoutingNoteSchema, RouteItemSchema, invalid }
export type { RouteItem }
