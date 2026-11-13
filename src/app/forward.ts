/** The automatic forwarding layer: a Ticket reply from a Source with feedback targets also goes to each extra target. */
import { key, type OutboundMessage, type Outbox as OutboxPort } from '../core/index.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Store } from './store.ts'

/** What the forwarding layer reads: the Ticket a reply belongs to, its origin Trigger, and the receipt to withdraw. */
export interface ForwardingHost {
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'receipts'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'check'>
}
/** The part of a Source's configuration the forwarding layer reads; other kinds simply have no targets. */
type FeedbackConfig = Record<string, unknown> & { feedbackUrls?: { id: string; url: string }[] }

/**
 * Wraps the Outbox so that each reply of a Ticket whose origin Source lists `feedbackUrls` is also queued once per
 * target, with its own receipt: a target that fails retries alone, and a target that is gone drops without resending the
 * others. The primary message is queued after every extra target accepted the text, so a Channel limit refuses the whole
 * reply before anything goes out. Acknowledgements and notices are not forwarded; neither are replies whose primary
 * Channel is already one of the targets.
 */
export class ForwardingOutbox implements OutboxPort {
  constructor(private readonly inner: OutboxPort, private readonly host: ForwardingHost) {}
  send(message: OutboundMessage): void {
    const extras = this.extras(message)
    // Validate every extra Channel first: the Engine's reply transaction then rolls back as a whole, and the agent that
    // wrote an oversized reply learns why before the primary message is queued.
    for (const extra of extras) this.host.sources.check(extra)
    this.inner.send(message)
    for (const extra of extras) this.inner.send(extra)
  }
  status(id: string) { return this.inner.status(id) }
  withdraw(id: string): void {
    this.inner.withdraw(id)
    for (const target of this.targets(id)) this.inner.withdraw(key('forward', id, target.id))
  }
  /** The copies a message needs beyond its primary Channel; empty when it is not a reply, is already a copy, or has no targets. */
  private extras(message: OutboundMessage): OutboundMessage[] {
    if (message.kind !== 'reply' || !message.ticketId || message.channel.address.forward === 'true') return []
    const ticketId = message.ticketId
    const source = this.originSource(ticketId)
    if (!source) return []
    return this.feedbackTargets(source)
      .filter(target => target.id !== message.channel.address.target)
      .map(target => ({ id: key('forward', message.id, target.id),
        channel: { source, thread: `${source}:${target.id}`, address: { target: target.id, forward: 'true' } },
        text: message.text, kind: 'reply' as const, ticketId }))
  }
  /** The extra targets of a reply that is being withdrawn; the receipt names its Ticket, whose origin names the Source. */
  private targets(id: string): { id: string }[] {
    const ticketId = this.host.store.receipts.get(id)?.ticketId
    const source = ticketId ? this.originSource(ticketId) : undefined
    return source ? this.feedbackTargets(source) : []
  }
  private originSource(ticketId: string): string | undefined {
    const origin = this.host.store.tickets.get(ticketId)?.origin
    return origin ? this.host.store.triggers.get(origin.triggerId)?.source : undefined
  }
  private feedbackTargets(source: string): { id: string; url: string }[] {
    const config = this.host.sources.instance<FeedbackConfig>(source)?.config
    return config?.feedbackUrls ?? []
  }
}
