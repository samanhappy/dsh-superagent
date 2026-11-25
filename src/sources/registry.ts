/** Registry of installed Source kinds, their configured instances, and the Engine's SourceScope implementation. */
import type { ChannelRef, OutboundMessage, ScopeResult, SourceScope, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { AdmissionTableSchema, type Settings } from '../policy.ts'
import type { ChannelLink, ChannelLinks, SourceInstance, SourceKind, TriggerContext, VariableSpec } from './kind.ts'


/**
 * Manages registered SourceKind plugins, validates their instance and policy configurations, and implements SourceScope for the Engine.
 * Claims each registered kind's health entries on HealthBoard and mediates access to source channels, links, environment variables, and thread context readers for Runtime, Settings, Outbox, and MasterAssessor.
 * A kind may run several instances: its own ID is the default instance, and an extra instance ID starts with `<kind>-`;
 * each instance has its own settings block, Policy part, Triggers, Threads, Channels and health entry.
 */
export class SourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, SourceKind>()
  /** Every claimed health entry by name, including the ones extra instances claim on first use. */
  private readonly entries = new Map<string, HealthEntry>()
  /** Health entry names each registered kind owns, released with the kind. */
  private readonly owned = new Map<string, Set<string>>()
  constructor(private readonly settings: () => Settings, private readonly board: Pick<HealthBoard, 'claim'> = new HealthBoard(),
    private readonly registered: (kind: SourceKind) => () => void = () => () => {}) {}

  /** Registers a SourceKind, claims its health entries on HealthBoard (rejecting `sync:` prefixes owned by Settings), and returns an unregister disposer. */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void {
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
    const refused = (name: string) => new Error(`Source kind ${kind.kind} declares the health entry ${name}, which another part reports`)
    const synced = kind.health.find(name => name.startsWith('sync:'))
    if (synced) throw refused(synced)
    // One health entry per instance keeps an extra instance's entry name equal to its own ID; a Policy sync is per instance too.
    if (kind.multi && kind.health.length !== 1) throw new Error(`Source kind ${kind.kind} runs several instances and needs exactly one health entry`)
    if (kind.multi && kind.policy?.sync) throw new Error(`Source kind ${kind.kind} runs several instances and cannot sync its Policy part`)
    const owned = new Set<string>()
    const release = () => { for (const name of owned) { this.entries.get(name)?.release(); this.entries.delete(name) } this.owned.delete(kind.kind) }
    for (const name of kind.health) {
      try { this.entries.set(name, this.board.claim(name, { state: 'starting', detail: '' })); owned.add(name) }
      catch { release(); throw refused(name) }
    }
    this.owned.set(kind.kind, owned)
    this.kinds.set(kind.kind, kind as unknown as SourceKind)
    const unregistered = this.registered(kind as unknown as SourceKind)
    return () => { this.kinds.delete(kind.kind); release(); unregistered() }
  }
  /** The already-claimed health entries among `names`; a name the kind did not claim is absent, so its reports become no-ops. */
  healthEntries(names: readonly string[]): Map<string, HealthEntry> {
    return new Map(names.flatMap(name => { const entry = this.entries.get(name); return entry ? [[name, entry] as const] : [] }))
  }
  /** The health entry a declared name or an extra instance's ID reports to; extra entries are claimed on first use. */
  healthEntry(kindId: string, name: string): HealthEntry | undefined {
    const kind = this.kinds.get(kindId)
    if (!kind) return undefined
    if (kind.health.includes(name)) return this.entries.get(name)
    if (!kind.multi || !name.startsWith(`${kind.kind}-`) || !this.instance(name)) return undefined
    let entry = this.entries.get(name)
    if (!entry) {
      entry = this.board.claim(name, { state: 'starting', detail: '' })
      this.entries.set(name, entry)
      this.owned.get(kind.kind)?.add(name)
    }
    return entry
  }
  /** The health entry names an instance reports: its kind's declared names for the default instance, or its own ID. */
  healthNames(instance: SourceInstance): string[] {
    const kind = this.kindFor(instance.id) ?? this.kinds.get(instance.kind)
    if (!kind) return []
    return instance.id === kind.kind ? [...kind.health] : [instance.id]
  }
  /** Releases a removed instance's health entry so it stops being shown as an orphan. */
  releaseInstance(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.release()
    this.entries.delete(id)
    for (const names of this.owned.values()) names.delete(id)
  }
  /** Whether an ID collides with an installed kind or one of its declared health entries. */
  reserved(id: string): boolean {
    return this.kinds.has(id) || [...this.kinds.values()].some(kind => kind.health.includes(id))
  }
  kind(id: string): SourceKind | undefined { return this.kinds.get(id) }
  /** The installed kind an instance ID belongs to: its own kind ID, or a `<kind>-…` ID of a kind that runs several instances. */
  kindFor(id: string): SourceKind | undefined {
    const exact = this.kinds.get(id)
    if (exact) return exact
    let found: SourceKind | undefined
    for (const kind of this.kinds.values()) {
      if (!kind.multi || !id.startsWith(`${kind.kind}-`)) continue
      if (!found || kind.kind.length > found.kind.length) found = kind
    }
    return found
  }
  /** Whether a Thread belongs to a chat Source, where a shared Thread follows live Tickets and at most one ended Ticket. */
  isChatThread(key: string): boolean {
    const at = key.indexOf(':')
    const source = at > 0 ? this.kindFor(key.slice(0, at)) : undefined
    return source?.chat === true
  }
  /** Every installed kind's default instance, the extra instances of kinds that run several, and stored instances whose kind is not installed. */
  instances(settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    const installed = [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).map(kind =>
      ({ ...this.resolve(kind, settings.sources[kind.kind], kind.kind), installed: true }))
    const extra = Object.entries(settings.sources).flatMap(([id, stored]) => {
      if (this.kinds.has(id)) return []
      const kind = this.kindFor(id)
      return kind ? [{ ...this.resolve(kind, stored, id), installed: true }] : []
    })
    const orphaned = Object.entries(settings.sources).filter(([id]) => !this.kindFor(id)).map(([id, stored]) =>
      ({ id, kind: id, enabled: stored.enabled, config: stored.config, installed: false }))
    return [...[...installed, ...extra].sort((a, b) => a.id.localeCompare(b.id)), ...orphaned]
  }
  instance<C extends Record<string, unknown>>(id: string, settings = this.settings()): SourceInstance<C> | undefined {
    const kind = this.kindFor(id)
    if (!kind) return undefined
    const stored = settings.sources[id]
    // An extra instance exists only once its ID is stored; the default instance exists as long as its kind is installed.
    if (!stored && id !== kind.kind) return undefined
    return this.resolve(kind, stored, id) as SourceInstance<C>
  }
  /** Validates an instance's settings, resolving the kind from the instance ID (so a new `<kind>-…` instance can be created). */
  validate(id: string, value: { enabled: boolean; config: unknown }): { enabled: boolean; config: Record<string, unknown> } {
    const kind = this.kindFor(id)
    if (!kind) throw new Error(`Source kind not installed: ${id}`)
    return { enabled: value.enabled, config: kind.schema.parse(value.config) }
  }
  /** Validates each Source's part of a submitted Policy; parts of uninstalled kinds and orphaned instances are kept as stored. */
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & { allowed: { id: string; name?: string }[] }> {
    return Object.fromEntries(Object.entries(parts).map(([id, part]) => {
      const policy = this.kindFor(id)?.policy
      // `admission` is validated by the Policy's own schema (shared across all kinds), while the kind validates the rest of its part.
      const { admission, ...rest } = part
      return [id, policy ? { ...policy.schema.parse(rest), admission: AdmissionTableSchema.parse(admission ?? {}) } : part as Record<string, unknown> & { allowed: { id: string; name?: string }[] }]
    }))
  }
  policyPart(id: string, settings = this.settings()) {
    const policy = this.kindFor(id)?.policy
    if (!policy) return undefined
    const { admission, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    return { ...parsed.success ? parsed.data : policy.schema.parse({}), admission: AdmissionTableSchema.safeParse(admission ?? {}).data ?? {} }
  }
  channelAllowed(channel: { source: string; address: Record<string, string> }, settings = this.settings()): boolean {
    const kind = this.kindFor(channel.source)
    if (!kind) return false
    const instance = this.instance(channel.source, settings)
    return !!instance?.enabled && (kind.channel?.allowed?.(channel.address, instance.config) ?? true)
  }
  /** Environment variable declarations for every installed kind, whether enabled or disabled. */
  declarations(): { kind: string; variables: readonly VariableSpec[] }[] {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => kind.environment ? [{ kind: kind.kind, variables: kind.environment.variables }] : [])
  }
  environments(settings = this.settings()) {
    return this.instances(settings).flatMap(instance => {
      const kind = this.kindFor(instance.id)
      return kind?.environment && instance.installed && instance.enabled
        ? [{ kind, environment: kind.environment, config: instance.config }] : []
    })
  }
  /**
   * Sends a message idempotently through its Channel's kind; returns `'waiting'` while the kind is not installed, or
   * `'gone'` when the target (or a kind without channels) can never receive it.
   */
  async send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const kind = this.kindFor(message.channel.source)
    if (!kind) return 'waiting'
    return kind.channel ? kind.channel.send({ commands }, message, this.configOf(message.channel.source, kind)) : 'gone'
  }
  /** Throws when the message's Channel refuses it as written, so the Outbox can refuse a reply before queueing it. */
  check(message: OutboundMessage): void {
    const kind = this.kindFor(message.channel.source)
    if (!kind?.channel) return
    if (message.images?.length && !kind.channel.supportsImages)
      throw new Error(`The ${kind.title.en} Channel cannot send images; send the text alone`)
    kind.channel.check?.(message, this.configOf(message.channel.source, kind))
  }
  /** The configuration a Channel sees, resolved at send time so a saved target takes effect on the next reply. */
  private configOf(source: string, kind: SourceKind): Record<string, unknown> {
    return this.instance(source)?.config ?? kind.schema.parse({})
  }
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const link = this.kindFor(channel.source)?.channel?.link(channel.address, links)
    return link ?? { url: '', label: { zh: channel.source, en: channel.source } }
  }
  find(query: string): { threads: string[]; terms: string[] } {
    const found = [...this.kinds.values()].flatMap(kind => kind.find ? [kind.find(query)] : [])
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }
  repliesTo(trigger: Trigger): string | undefined { return this.kindFor(trigger.source)?.repliesTo?.(trigger) }
  threadContext(trigger: Trigger, settings = this.settings()): TriggerContext | undefined {
    const kind = this.kindFor(trigger.source)
    const context = kind?.threadContext
    if (!kind || !context) return undefined
    const config = this.instance(trigger.source, settings)?.config ?? kind.schema.parse({})
    return {
      messageId: context.messageId(trigger),
      read: (commands, part, cursor) => context.read(commands, trigger, part, cursor, config),
      images: text => context.images?.(text) ?? [],
      image: async (agent, commands, message, key, stateDir, signal) => {
        if (!context.image) throw new Error(`The ${kind.kind} Source has no images`)
        return context.image(agent, commands, trigger, message, key, stateDir, signal)
      },
    }
  }
  scope(input: { source: string; meta: Record<string, unknown> }, settings = this.settings()): ScopeResult {
    const kind = this.kindFor(input.source)
    const stored = settings.sources[input.source]
    // Without its kind plugin the stored scope cannot be evaluated, so a configured Source whose plugin is missing listens to nothing.
    if (!kind) return stored ? { listened: false, reason: 'source_not_installed' } : { listened: true, observed: false }
    const instance = this.instance(input.source, settings)
    if (!instance?.enabled) return { listened: false, reason: 'source_disabled' }
    return kind.scope ? kind.scope({ meta: input.meta }, instance.config) : { listened: true, observed: false }
  }
  /** Falls back to schema defaults and disables the instance when stored configuration fails validation. */
  private resolve(kind: SourceKind, stored: { enabled: boolean; config: Record<string, unknown> } | undefined, id: string): SourceInstance {
    const parsed = kind.schema.safeParse(stored?.config ?? {})
    return { id, kind: kind.kind, enabled: parsed.success && (stored?.enabled ?? true), config: parsed.success ? parsed.data : kind.schema.parse({}) }
  }
}
