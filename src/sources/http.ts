/** HTTP Source kind: polls an HTTP endpoint for system alerts and collected human feedback, with replies forwarded to WeCom. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, threadKey, type ChannelRef, type OutboundMessage, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { checkedImText } from '../infra/text.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause } from './poll.ts'

/** The kind id, its settings key, the health entry and the source of its Triggers and Channels. */
export const SOURCE = 'http'
/** A WeCom group robot accepts at most this many bytes of markdown. */
export const WECOM_GROUP_MAX_BYTES = 4096
/** Consecutive failed rounds before the Source reports an error; one failure stays quiet and is retried at once. */
const MAX_FAILURES = 3
/** Largest accepted page, so a wrong endpoint cannot exhaust memory. */
const MAX_PAGE_CHARS = 5_000_000
/** The kind an HTTP Source's primary replies go to when `feedbackChatId` names a conversation. */
const WECOM = 'wecom'

const HeaderSchema = z.object({ name: z.string().regex(/^[A-Za-z0-9-]+$/), value: z.string().max(4000) }).strict()
/** One event kind the operator accepts, and how it is authorized: a person's submission or a system's own event. */
const EventSchema = z.object({
  kind: z.string().regex(/^[a-z0-9-]+$/),
  origin: z.enum(['person', 'system']).default('system'),
  addressed: z.enum(['none', 'direct', 'mention']).default('none'),
}).strict()
/** One extra WeCom group robot webhook; `id` appears in Channel addresses and receipts, `url` is the credential. */
const FeedbackUrlSchema = z.object({ id: z.string().regex(/^[a-z0-9-]+$/),
  url: z.string().trim().max(2000).refine(value => /^https:\/\/[^\s]+$/.test(value), 'https:// URL') }).strict()
export const HttpConfigSchema = z.object({
  url: z.string().trim().max(2000).default('')
    .refine(value => value === '' || /^https?:\/\/[^\s]+$/.test(value), 'http:// or https:// URL'),
  method: z.enum(['GET', 'POST']).default('GET'),
  headers: z.array(HeaderSchema).default([]),
  intervalSeconds: z.number().int().min(10).max(3600).default(60),
  events: z.array(EventSchema).default([])
    .refine(events => new Set(events.map(event => event.kind)).size === events.length, 'Duplicate event kinds'),
  /** The WeCom conversation (a group's or a person's chatId) that primary replies go to, over the existing WeCom Source. */
  feedbackChatId: z.string().trim().max(200).default('')
    .transform(value => value.startsWith(`${WECOM}:`) ? value.slice(WECOM.length + 1) : value),
  /** Extra WeCom group robot webhooks; each gets a forwarded copy of every reply. */
  feedbackUrls: z.array(FeedbackUrlSchema).default([])
    .refine(urls => new Set(urls.map(url => url.id)).size === urls.length, 'Duplicate feedback target ids'),
  timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
}).strict()
export type HttpConfig = ReturnType<typeof HttpConfigSchema.parse>
export type HttpEvent = ReturnType<typeof EventSchema.parse>

/** One item of the endpoint's page: a system alert when `kind` is declared `system`, a person's feedback when `person`. */
export const HttpItemSchema = z.looseObject({
  id: z.string().trim().min(1).max(200),
  kind: z.string().trim().min(1).max(100),
  actor: z.string().trim().max(200).default(''),
  text: z.string(),
  at: z.string(),
  thread: z.string().trim().min(1).max(200).optional(),
  url: z.string().optional(),
})
export type HttpItem = ReturnType<typeof HttpItemSchema.parse>
/** The endpoint's page: oldest first, with `next` as the cursor of the following page; omit it or send `null` on the last page. */
const PageSchema = z.looseObject({ items: z.array(z.unknown()), next: z.string().nullish() })
type Page = ReturnType<typeof PageSchema.parse>
const GroupAnswerSchema = z.looseObject({ errcode: z.number().default(0), errmsg: z.string().default('') })

/** The conversation a reply goes to: the configured WeCom chat, or the first feedback target as a fallback. */
export function feedbackChannel(config: HttpConfig): ChannelRef | undefined {
  if (config.feedbackChatId) {
    return { source: WECOM, thread: `${WECOM}:${config.feedbackChatId}`, address: { chatId: config.feedbackChatId } }
  }
  const first = config.feedbackUrls[0]
  return first ? { source: SOURCE, thread: `${SOURCE}:${first.id}`, address: { target: first.id } } : undefined
}

/** Maps one page item to a Trigger; an undeclared kind is still recorded, so `scope` can show it as filtered. */
export function httpTrigger(item: HttpItem, config: HttpConfig): Trigger {
  const event = config.events.find(candidate => candidate.kind === item.kind)
  const thread = item.thread ?? item.id
  const addressed = event?.origin === 'person' && event.addressed !== 'none' ? { addressed: event.addressed } : {}
  const channel = feedbackChannel(config)
  return {
    id: key(SOURCE, item.id), source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: item.actor },
    human: event?.origin === 'person',
    ...addressed, at: item.at, text: item.text,
    ...(channel ? { channel } : {}), ...(item.url ? { url: item.url } : {}),
    meta: { itemId: item.id, kind: item.kind, thread },
  }
}

/** Truncates `text` to `max` UTF-8 bytes without splitting a character; used only as a last resort for a Channel's hard limit. */
function truncateBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text
  let kept = ''
  let used = 0
  for (const character of text) {
    const size = Buffer.byteLength(character)
    if (used + size > max) break
    kept += character
    used += size
  }
  return kept
}

/** Refuses text a WeCom group robot can never accept, before the Outbox queues it. */
export function checkFeedback(message: OutboundMessage, _config: HttpConfig): void {
  checkedImText(message.text)
  const bytes = Buffer.byteLength(message.text)
  if (bytes > WECOM_GROUP_MAX_BYTES) {
    throw new Error(`The feedback message is ${bytes} bytes; a WeCom group bot accepts at most ${WECOM_GROUP_MAX_BYTES} bytes. Rewrite it as a shorter update.`)
  }
}

/** Posts one markdown message to a WeCom group robot; any non-zero `errcode` is retried, because a revoked bot or a wrong URL can be fixed. */
export async function sendFeedback(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage, config: HttpConfig): Promise<'sent' | 'gone'> {
  const target = config.feedbackUrls.find(candidate => candidate.id === message.channel.address.target)
  if (!target) return 'gone'
  const content = truncateBytes(checkedImText(message.text), WECOM_GROUP_MAX_BYTES)
  const response = await fetch(target.url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }), signal: AbortSignal.timeout(config.timeoutMs) })
  if (!response.ok) throw new Error(`The WeCom group bot answered HTTP ${response.status}`)
  const answer = GroupAnswerSchema.parse(await response.json())
  if (answer.errcode !== 0) throw new Error(`The WeCom group bot answered ${answer.errcode}: ${answer.errmsg}`)
  return 'sent'
}

/** Reads one page and hands every valid item to the Engine; the cursor moves only after the whole page was taken in. */
export async function pollHttp(ctx: SourceContext, config: HttpConfig, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const cursor = ctx.state.get(KV.http.cursor) ?? ''
  const page = await requestPage(config, cursor, signal)
  let unreadable = 0
  for (const raw of page.items) {
    if (signal.aborted) throw new Error('The HTTP Source stopped during the round')
    const parsed = HttpItemSchema.safeParse(raw)
    if (!parsed.success) { unreadable += 1; continue }
    const trigger = httpTrigger(parsed.data, config)
    await ctx.receive(trigger)
    ctx.threads.describe(threadKey(trigger.threads[0]!), { label: parsed.data.kind, ...(parsed.data.url ? { url: parsed.data.url } : {}) })
  }
  // Without `next` the next round reads the same page; deterministic Trigger ids make that a no-op instead of a gap.
  if (page.next) ctx.state.set(KV.http.cursor, page.next)
  return { read: page.items.length, unreadable }
}

async function requestPage(config: HttpConfig, cursor: string, signal: AbortSignal): Promise<Page> {
  const url = new URL(config.url)
  if (config.method === 'GET') url.searchParams.set('after', cursor)
  const headers = Object.fromEntries(config.headers.map(header => [header.name, header.value]))
  const controller = new AbortController()
  const stop = () => controller.abort()
  signal.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const response = await fetch(url, {
      method: config.method,
      headers: config.method === 'POST' && !Object.keys(headers).some(name => name.toLowerCase() === 'content-type')
        ? { ...headers, 'content-type': 'application/json' } : headers,
      ...(config.method === 'POST' ? { body: JSON.stringify({ after: cursor }) } : {}),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`The HTTP endpoint answered HTTP ${response.status}`)
    const text = await response.text()
    if (text.length > MAX_PAGE_CHARS) throw new Error(`The HTTP endpoint answered more than ${MAX_PAGE_CHARS} characters`)
    return PageSchema.parse(JSON.parse(text))
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}

/** The polling loop: waits for setup, follows the Source's switch, reports health, backs off and stops on abort. */
export async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) {
    ctx.report(SOURCE, health('paused', 'setupPending'))
    return
  }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<HttpConfig>(SOURCE)
    if (!config) ctx.report(SOURCE, health('paused', 'sourceOff'))
    else if (!config.url) ctx.report(SOURCE, health('paused', 'httpUnset'))
    else {
      try {
        const round = await pollHttp(ctx, config, signal)
        failures = 0
        ctx.report(SOURCE, { state: 'ready', detail: `${round.read} items, ${round.unreadable} unreadable`, at: new Date().toISOString() })
      } catch (error) {
        if (signal.aborted) return
        failures += 1
        if (failures >= MAX_FAILURES) ctx.report(SOURCE, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
      }
    }
    await pause((config?.intervalSeconds ?? 60) * 1000, signal)
  }
}

/** The HTTP Source: one endpoint polled for alerts and feedback, and WeCom Channels for its replies. */
export const httpKind: SourceKind<HttpConfig> = {
  kind: SOURCE,
  title: { zh: 'HTTP 事件', en: 'HTTP events' },
  description: {
    zh: '轮询 HTTP 接口，把系统告警或系统收集到的人工反馈转为 Trigger；结果反馈到企业微信会话或群机器人。',
    en: 'Polls an HTTP endpoint for system alerts or human feedback a system collected, and sends replies to a WeCom conversation or group bots.',
  },
  schema: HttpConfigSchema,
  fields: [
    { key: 'url', type: 'text', label: { zh: 'HTTP 接口地址', en: 'HTTP endpoint' },
      hint: { zh: '轮询这个地址；GET 用 ?after=<cursor> 取下一页，POST 的请求体是 {"after": "..."}。响应是 {"items": [...], "next": "..."}。',
        en: 'Polled with ?after=<cursor> (GET) or a {"after": "..."} body (POST); it answers {"items": [...], "next": "..."}.' } },
    { key: 'method', type: 'select', options: [{ value: 'GET', label: { zh: 'GET', en: 'GET' } }, { value: 'POST', label: { zh: 'POST', en: 'POST' } }],
      advanced: true, label: { zh: '请求方法', en: 'Request method' } },
    { key: 'headers', type: 'rows', label: { zh: '请求头', en: 'Request headers' },
      hint: { zh: '例如 Authorization: Bearer …；值按凭据处理，不会写进日志。', en: 'For example Authorization: Bearer …; values are credentials and never logged.' },
      columns: [{ key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, pattern: '[A-Za-z0-9\\-]+' },
        { key: 'value', type: 'text', label: { zh: '值', en: 'Value' } }] },
    { key: 'intervalSeconds', type: 'number', min: 10, max: 3600, advanced: true, label: { zh: '轮询间隔（秒）', en: 'Polling interval (seconds)' } },
    { key: 'events', type: 'rows', label: { zh: '接收的事件类型', en: 'Event kinds received' },
      hint: { zh: '只接收这里声明的事件类型；未声明的记为 filtered。person 走 allowed 名单，点名为 direct/mention 时直接建单；system 走 bots 或准入表，且需要 auto 模式。',
        en: 'Only these kinds are received; others are recorded as filtered. A person kind uses the allowed list and becomes an explicit request when addressed direct or mention; a system kind needs the bots list or the admission table, and auto mode.' },
      columns: [{ key: 'kind', type: 'text', label: { zh: '类型', en: 'Kind' }, pattern: '[a-z0-9\\-]+' },
        { key: 'origin', type: 'select', options: [{ value: 'person', label: { zh: '人提交', en: 'Person' } }, { value: 'system', label: { zh: '系统', en: 'System' } }],
          label: { zh: '来源', en: 'Origin' } },
        { key: 'addressed', type: 'select', options: [{ value: 'none', label: { zh: '不点名', en: 'Not addressed' } },
          { value: 'direct', label: { zh: '直接提交', en: 'Direct' } }, { value: 'mention', label: { zh: '@ 智能体', en: 'Mention' } }],
        label: { zh: '点名方式', en: 'Addressed' } }] },
    { key: 'feedbackChatId', type: 'text', label: { zh: '主出站：企业微信会话 chatId', en: 'Primary outbound: WeCom conversation chatId' },
      hint: { zh: '结果走现有企业微信 Source 的机器人长连接发到这个会话；在 Threads 页复制 wecom:<chatId> 里的 chatId。留空时用第一条反馈通道作主出站。',
        en: 'Replies go to this conversation over the existing WeCom Source\'s bot connection; copy the chatId from a wecom:<chatId> Thread key. Empty makes the first feedback target primary.' } },
    { key: 'feedbackUrls', type: 'rows', label: { zh: '额外的群机器人反馈通道', en: 'Extra group-bot feedback targets' },
      hint: { zh: '每条都是企业微信群机器人的 webhook；每次回复都会自动转发一份。URL 是凭据，按密码管理。',
        en: 'Each is a WeCom group robot webhook; every reply is forwarded to it. The URL is a credential and is handled like a password.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '标识', en: 'ID' }, pattern: '[a-z0-9\\-]+' },
        { key: 'url', type: 'text', label: { zh: 'Webhook 地址', en: 'Webhook URL' } }] },
    { key: 'timeoutMs', type: 'number', min: 1000, max: 60000, advanced: true, label: { zh: '请求超时（毫秒）', en: 'Request timeout (ms)' } },
  ],
  health: [SOURCE],
  // A declared kind is received; an undeclared one is recorded as filtered, so the panel explains it instead of hiding it.
  scope: ({ meta }, config) => config.events.some(event => event.kind === meta.kind)
    ? { listened: true, observed: true, row: 'default' }
    : { listened: false, reason: 'kind_not_listed' },
  channel: {
    allowed: (address, config) => config.feedbackUrls.some(target => target.id === address.target),
    check: checkFeedback,
    send: sendFeedback,
    link: address => ({ url: '', label: { zh: `HTTP 反馈${address.target ? ` · ${address.target}` : ''}`,
      en: `HTTP feedback${address.target ? ` · ${address.target}` : ''}` } }),
  },
  policy: {
    unnamed: { person: { zh: 'HTTP 提交人', en: 'HTTP submitter' }, bot: { zh: 'HTTP 系统', en: 'HTTP system' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict())
        .refine(list => new Set(list.map(entry => entry.id)).size === list.length, 'Duplicate senders').default([]),
      bots: z.array(z.object({ id: z.string().trim().min(1).max(200) }).strict())
        .refine(list => new Set(list.map(entry => entry.id)).size === list.length, 'Duplicate bots').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能通过 HTTP 提交请求的人', en: 'People who may submit requests over HTTP' },
        columns: [{ key: 'id', type: 'text', label: { zh: '提交人', en: 'Submitter' } },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的系统', en: 'Systems whose events may become candidates' },
        hint: { zh: '名单里的系统事件成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。',
          en: 'An event of a system on this list becomes an inferred candidate for an assessment; it never makes an explicit request or stops a ticket.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '系统', en: 'System' } }] },
    ],
    explicit: { zh: '名单里的人通过 HTTP 来源提交人工反馈（事件类型声明为 person）。',
      en: 'A person on the list submits feedback through the HTTP Source (an event kind declared as person).' },
    rows: () => [{ id: 'default', label: { zh: 'HTTP 事件', en: 'HTTP events' }, note: { zh: '全部', en: 'All' },
      cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } }],
  },
}

export const name = 'dsh-superagent-http'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(httpKind), 'http: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, httpKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
