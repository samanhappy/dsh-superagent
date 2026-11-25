/** Queues the idle retrospective ("dreaming") to the main Session when no Ticket is open and the configured interval has elapsed. */
import { KV } from '../kv.ts'
import type { Settings } from '../policy.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'

/** How often an idle check runs; the interval setting decides whether a review is due. */
const CHECK_MS = 60_000

/** The relay text: what a dreaming review reads, where lessons persist, and what it must not do on its own. */
export const DREAMING_PROMPT = `Idle retrospective ("dreaming"). No Ticket is open, so take stock of the work this agent has done and turn it into durable experience rather than a summary that dies with this turn.

1. Read the recent history with orchestrator_read: the \`tickets\` resource (newest first), then \`ticket/<id>\` for the Tickets that ended and their reports since the last review, and \`trigger/<id>\` where the request or the context matters.
2. Find reusable lessons, not a report of what happened. Good candidates: a repeated mistake in how you assessed, routed or answered; a missing check a worker had to redo; a policy or prompt rule that caused a wrong or noisy decision; a product convention you had to rediscover.
3. Persist each lesson where it changes future behavior:
   - About this agent: save a custom skill or edit the team prompt with orchestrator_prompts_save against its current revision (read \`prompts\` first). Keep it short and precise; one or two lessons beat a long list.
   - About a defect in the orchestration code: prepare a change to the dsh-superagent repository and open a merge request.
   - About the 智能问数 product (sunmeng/ai-data): when the evidence makes the fix certain, open a merge request to dev with the change and its tests; when it is not certain, do not guess. Record the open question in the dreaming skill so the owner sees it, and raise it the next time the owner writes to you.
4. Never change policy, admission rules or settings on your own; propose those to the owner instead.
5. If nothing is worth persisting, end quietly. Do not message the owner about a routine review; only a ready, user-visible result or a material risk is worth a message.`

/** What a `Dreaming` run reads and writes: settings, open Tickets, the last run and the main Session's relay queue. */
export interface DreamingHost {
  readonly store: Pick<Store, 'get' | 'set' | 'tickets'>
  readonly sessions: Pick<Sessions, 'relay'>
  readonly settings: () => { eval: Pick<Settings['eval'], 'dreaming'> }
  readonly configured: () => boolean
  readonly closing: () => boolean
  readonly now?: () => number
  readonly report?: (error: unknown) => void
}

/**
 * Runs one idle retrospective per configured interval. A review is due only while the agent is idle: no Ticket is open,
 * setup is complete and the process is not closing. The last run is recorded before the relay is queued, so a restart
 * does not repeat it; the relay itself is durable in the effect queue and starts the main Session's turn.
 */
export class Dreaming {
  private timer?: ReturnType<typeof setInterval>
  private checking = false
  constructor(private readonly host: DreamingHost) {}
  /** Starts the idle check timer; the first due review waits for the next tick rather than firing at startup. */
  start(): void { this.timer ??= setInterval(() => void this.check(), CHECK_MS) }
  stop(): void { clearInterval(this.timer); this.timer = undefined }
  /** Queues a review if one is due; exposed for tests and for an immediate check after a settings save. */
  async check(): Promise<void> {
    if (this.checking || !this.host.configured() || this.host.closing()) return
    const { enabled, intervalHours } = this.host.settings().eval.dreaming
    if (!enabled || this.host.store.tickets.open().length) return
    const now = this.host.now?.() ?? Date.now()
    const last = this.host.store.get(KV.dreaming.lastRun)
    if (last !== undefined && now - Date.parse(last) < intervalHours * 3_600_000) return
    this.checking = true
    const at = new Date(now).toISOString()
    try {
      this.host.sessions.relay(`dreaming:${at}`, DREAMING_PROMPT)
      this.host.store.set(KV.dreaming.lastRun, at)
    } catch (error) { this.host.report?.(error) } finally { this.checking = false }
  }
}
