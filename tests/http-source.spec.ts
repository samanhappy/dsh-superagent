import { afterEach, describe, expect, it, vi } from 'vitest'
import { key, type OutboundMessage } from '../src/core/index.ts'
import type { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema } from '../src/policy.ts'
import { checkFeedback, feedbackChannel, httpKind, httpTrigger, HttpConfigSchema, pollHttp, sendFeedback, watch }
  from '../src/sources/http.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { SourceRegistry } from '../src/sources/registry.ts'

const answer = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const config = (value: Record<string, unknown> = {}) => HttpConfigSchema.parse({
  url: 'https://example.com/events',
  events: [{ kind: 'alert', origin: 'system' }, { kind: 'feedback', origin: 'person', addressed: 'direct' }],
  feedbackChatId: 'wr_team', ...value,
})
const item = (value: Record<string, unknown> = {}) => ({ id: 'event-1', kind: 'alert', actor: 'monitor', text: 'CPU is high',
  at: '2026-01-01T00:00:00.000Z', ...value })
function context(overrides: Record<string, unknown> = {}) {
  const state = new Map<string, string>()
  const receive = vi.fn(async (_trigger: unknown) => 'stored')
  const describe = vi.fn()
  const report = vi.fn()
  const value = { ready: Promise.resolve(), configured: () => true, config: () => undefined,
    state: { get: (name: string) => state.get(name), set: (name: string, text: string) => { state.set(name, text) } },
    receive, threads: { describe }, report, ...overrides } as unknown as SourceContext
  return { value, state, receive, describe, report }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('HTTP Trigger translation', () => {
  it('turns a person event into an explicit request addressed to the agent, with WeCom as its primary Channel', () => {
    const trigger = httpTrigger(item({ kind: 'feedback', actor: 'ou_alice', text: 'please fix the report',
      thread: 'case-7', url: 'https://example.com/cases/7' }), config())
    expect(trigger).toMatchObject({ id: key('http', 'event-1'), source: 'http', human: true, addressed: 'direct',
      actor: { source: 'http', id: 'ou_alice' }, text: 'please fix the report', url: 'https://example.com/cases/7',
      threads: [{ source: 'http', id: 'case-7' }],
      channel: { source: 'wecom', thread: 'wecom:wr_team', address: { chatId: 'wr_team' } },
      meta: { itemId: 'event-1', kind: 'feedback', thread: 'case-7' } })
  })
  it('turns a system event into a non-human candidate without an addressed flag', () => {
    const trigger = httpTrigger(item(), config())
    expect(trigger).toMatchObject({ human: false, id: key('http', 'event-1'), threads: [{ source: 'http', id: 'event-1' }] })
    expect(trigger.addressed).toBeUndefined()
  })
  it('uses the first feedback target when no WeCom conversation is configured, and no Channel when neither is', () => {
    const url = { feedbackChatId: '', feedbackUrls: [{ id: 'ops', url: 'https://example.com/hook' }] }
    expect(feedbackChannel(config(url))).toEqual({ source: 'http', thread: 'http:ops', address: { target: 'ops' } })
    expect(feedbackChannel(config({ feedbackChatId: '', feedbackUrls: [] }))).toBeUndefined()
  })
  it('records an undeclared kind as filtered instead of dropping it', () => {
    const trigger = httpTrigger(item({ kind: 'unlisted' }), config())
    const scope = httpKind.scope!(trigger, config())
    expect(scope).toEqual({ listened: false, reason: 'kind_not_listed' })
    expect(httpKind.scope!(httpTrigger(item(), config()), config())).toEqual({ listened: true, observed: true, row: 'default' })
  })
})

describe('HTTP polling', () => {
  it('stores every valid item before moving the cursor, and counts unreadable ones', async () => {
    const contextValue = context()
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => answer({ items: [item(), { id: 'broken' }, item({ id: 'event-2', kind: 'feedback' })], next: 'page-2' }))
    vi.stubGlobal('fetch', fetchMock)
    const round = await pollHttp(contextValue.value, config(), new AbortController().signal)
    expect(round).toEqual({ read: 3, unreadable: 1 })
    expect(contextValue.receive).toHaveBeenCalledTimes(2)
    expect(contextValue.receive.mock.calls[0]![0]).toMatchObject({ id: key('http', 'event-1'), human: false })
    expect(contextValue.receive.mock.calls[1]![0]).toMatchObject({ id: key('http', 'event-2'), human: true, addressed: 'direct' })
    expect(contextValue.describe).toHaveBeenCalledTimes(2)
    expect(contextValue.state.get('http-cursor')).toBe('page-2')
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://example.com/events?after=')
  })
  it('sends the cursor in a POST body and keeps the cursor when the page has no next', async () => {
    const contextValue = context()
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => answer({ items: [item()], next: null }))
    vi.stubGlobal('fetch', fetchMock)
    contextValue.state.set('http-cursor', 'page-1')
    await pollHttp(contextValue.value, config({ method: 'POST' }), new AbortController().signal)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://example.com/events')
    expect(init).toMatchObject({ method: 'POST', body: '{"after":"page-1"}', headers: { 'content-type': 'application/json' } })
    expect(contextValue.state.get('http-cursor')).toBe('page-1')
  })
  it('leaves the cursor untouched when the endpoint or one item fails', async () => {
    const failed = context()
    context()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, _init: RequestInit) => answer({ items: [] }, 500)))
    await expect(pollHttp(failed.value, config(), new AbortController().signal)).rejects.toThrow('HTTP 500')
    expect(failed.state.get('http-cursor')).toBeUndefined()
    const stopped = context({ receive: vi.fn(async () => { throw new Error('engine refused') }) })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, _init: RequestInit) => answer({ items: [item()], next: 'page-2' })))
    await expect(pollHttp(stopped.value, config(), new AbortController().signal)).rejects.toThrow('engine refused')
    expect(stopped.state.get('http-cursor')).toBeUndefined()
  })
})

describe('WeCom group-bot feedback', () => {
  it('posts markdown to the target and reports a non-zero errcode as retryable', async () => {
    const message: OutboundMessage = { id: 'm1', channel: { source: 'http', thread: 'http:ops', address: { target: 'ops' } },
      text: 'done', kind: 'reply' }
    const feedback = config({ feedbackChatId: '', feedbackUrls: [{ id: 'ops', url: 'https://example.com/hook' }] })
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => answer({ errcode: 0 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(sendFeedback({} as never, message, feedback)).resolves.toBe('sent')
    const [, init] = fetchMock.mock.calls[0]!
    expect(JSON.parse(String(init!.body))).toEqual({ msgtype: 'markdown', markdown: { content: 'done' } })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, _init: RequestInit) => answer({ errcode: 93000, errmsg: 'invalid webhook url' })))
    await expect(sendFeedback({} as never, message, feedback)).rejects.toThrow('93000')
  })
  it('refuses text over the group robot word or byte limit before the Outbox queues it', () => {
    const message = (text: string): OutboundMessage => ({ id: 'm1', channel: { source: 'http', thread: 'http:ops', address: { target: 'ops' } },
      text, kind: 'reply' })
    expect(() => checkFeedback(message(Array.from({ length: 101 }, (_, index) => `w${index}`).join(' ')), config())).toThrow()
    expect(() => checkFeedback(message('a'.repeat(4097)), config())).toThrow('4096')
    expect(() => checkFeedback(message('a'.repeat(4096)), config())).not.toThrow()
  })
  it('passes the saved target list to the Channel, so a reply sent through the registry reaches its webhook', async () => {
    const settings = SettingsSchema.parse({ sources: { http: { enabled: true, config: { url: 'https://example.com/events',
      feedbackChatId: '', feedbackUrls: [{ id: 'ops', url: 'https://example.com/hook' }] } } } })
    const sources = new SourceRegistry(() => settings, new HealthBoard())
    sources.register(httpKind)
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => answer({ errcode: 0 }))
    vi.stubGlobal('fetch', fetchMock)
    const message: OutboundMessage = { id: 'm1', channel: { source: 'http', thread: 'http:ops', address: { target: 'ops' } },
      text: 'done', kind: 'reply' }
    await expect(sources.send(message, {} as Commands)).resolves.toBe('sent')
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://example.com/hook')
  })
})

describe('HTTP Source loop', () => {
  it('stays paused until setup and until the endpoint URL is set', async () => {
    const unconfigured = context({ configured: () => false })
    await watch(unconfigured.value, new AbortController().signal)
    expect(unconfigured.report).toHaveBeenCalledWith('http', expect.objectContaining({ state: 'paused', code: 'setupPending' }))
    const empty = context({ config: () => config({ url: '' }) })
    const controller = new AbortController()
    const running = watch(empty.value, controller.signal)
    await vi.waitFor(() => expect(empty.report).toHaveBeenCalledWith('http', expect.objectContaining({ state: 'paused', code: 'httpUnset' })))
    controller.abort()
    await running
  })
  it('reports an error after three consecutive failed rounds', async () => {
    const failed = context({ config: () => ({ ...config(), intervalSeconds: 0.001 }), state: { get: () => undefined, set: () => {} } })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, _init: RequestInit) => answer({ items: [] }, 500)))
    const controller = new AbortController()
    const running = watch(failed.value, controller.signal)
    await vi.waitFor(() => expect(failed.report).toHaveBeenCalledWith('http',
      expect.objectContaining({ state: 'error', code: 'pollFailures' })), { timeout: 2000 })
    controller.abort()
    await running
  })
})

describe('HTTP kind and Policy', () => {
  it('declares one health entry and one admission row', () => {
    expect(httpKind.health).toEqual(['http'])
    expect(httpKind.policy!.rows!(config())[0]).toMatchObject({ id: 'default',
      cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } })
    expect(httpKind.channel!.allowed!({ target: 'ops' }, config({ feedbackChatId: '', feedbackUrls: [{ id: 'ops', url: 'https://example.com/hook' }] }))).toBe(true)
    expect(httpKind.channel!.allowed!({ target: 'other' }, config({ feedbackChatId: '', feedbackUrls: [{ id: 'ops', url: 'https://example.com/hook' }] }))).toBe(false)
  })
  it('maps a ticket channel to a label without exposing the webhook URL', () => {
    const link = httpKind.channel!.link({ target: 'ops' }, {})
    expect(link).toMatchObject({ url: '', label: { en: 'HTTP feedback · ops' } })
  })
  it('is a kind the plugin can register', () => {
    expect(httpKind.kind).toBe('http')
    expect(httpKind.schema.parse({})).toMatchObject({ url: '', method: 'GET', intervalSeconds: 60, feedbackUrls: [] })
    expect(HttpConfigSchema.parse({ feedbackChatId: 'wecom:wr_team' }).feedbackChatId).toBe('wr_team')
    expect(() => HttpConfigSchema.parse({ feedbackUrls: [{ id: 'ops', url: 'not-a-url' }] })).toThrow()
    expect(() => HttpConfigSchema.parse({ feedbackUrls: [{ id: 'ops', url: 'http://example.com/hook' }] })).toThrow()
  })
})
