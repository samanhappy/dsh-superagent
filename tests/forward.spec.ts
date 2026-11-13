import { describe, expect, it, vi } from 'vitest'
import { key, type OutboundMessage } from '../src/core/index.ts'
import { ForwardingOutbox, type ForwardingHost } from '../src/app/forward.ts'

const reply = (overrides: Partial<OutboundMessage> = {}): OutboundMessage => ({ id: 'm1',
  channel: { source: 'wecom', thread: 'wecom:wr_team', address: { chatId: 'wr_team' } },
  text: 'done', kind: 'reply', ticketId: 't1', ...overrides })
function setup(options: { urls?: { id: string; url: string }[]; source?: string; ticketId?: string } = {}) {
  const urls = options.urls ?? [{ id: 'ops', url: 'https://example.com/ops' }, { id: 'dev', url: 'https://example.com/dev' }]
  const source = options.source ?? 'http'
  const ticketId = options.ticketId ?? 't1'
  const sent: OutboundMessage[] = []
  const withdrawn: string[] = []
  const inner = { send: (message: OutboundMessage) => { sent.push(message) }, status: () => undefined,
    withdraw: (id: string) => { withdrawn.push(id) } }
  const store = {
    tickets: { get: (id: string) => id === ticketId ? { id, origin: { triggerId: 'tr1', triggerIds: ['tr1'] } } : undefined },
    triggers: { get: (id: string) => id === 'tr1' ? { id, source } : undefined },
    receipts: { get: (id: string) => id === 'm1' ? { ...reply(), status: 'sent' } : undefined },
  } as unknown as ForwardingHost['store']
  const check = vi.fn()
  const sources = { instance: () => ({ config: { feedbackUrls: urls } }), check } as unknown as ForwardingHost['sources']
  return { outbox: new ForwardingOutbox(inner, { store, sources }), sent, withdrawn, check, urls }
}

describe('ForwardingOutbox', () => {
  it('queues the primary reply and one deterministic copy per extra target', () => {
    const { outbox, sent, check } = setup()
    outbox.send(reply())
    expect(sent.map(message => message.id)).toEqual(['m1', key('forward', 'm1', 'ops'), key('forward', 'm1', 'dev')])
    expect(sent[1]).toMatchObject({ kind: 'reply', text: 'done', ticketId: 't1',
      channel: { source: 'http', thread: 'http:ops', address: { target: 'ops', forward: 'true' } } })
    expect(sent[2]).toMatchObject({ channel: { source: 'http', thread: 'http:dev', address: { target: 'dev', forward: 'true' } } })
    expect(check).toHaveBeenCalledTimes(2)
  })
  it('does not copy a reply back to the target that already carries it', () => {
    const { outbox, sent } = setup()
    outbox.send(reply({ channel: { source: 'http', thread: 'http:ops', address: { target: 'ops' } } }))
    expect(sent.map(message => message.id)).toEqual(['m1', key('forward', 'm1', 'dev')])
  })
  it('forwards only Ticket replies, not acknowledgements, notices, copies or messages without a Ticket', () => {
    const { outbox, sent } = setup()
    outbox.send(reply({ kind: 'acknowledgement' }))
    outbox.send(reply({ kind: 'notice' }))
    outbox.send(reply({ ticketId: undefined }))
    outbox.send(reply({ channel: { source: 'wecom', thread: 'wecom:wr_team', address: { chatId: 'wr_team', forward: 'true' } } }))
    expect(sent.map(message => message.id)).toEqual(['m1', 'm1', 'm1', 'm1'])
  })
  it('refuses the whole reply before queueing anything when an extra target rejects the text', () => {
    const { outbox, sent, check } = setup()
    check.mockImplementation((message: OutboundMessage) => {
      if (message.channel.address.target === 'dev') throw new Error('too long')
    })
    expect(() => outbox.send(reply())).toThrow('too long')
    expect(sent).toEqual([])
  })
  it('leaves the primary alone when the origin Source has no targets or the message names no Ticket', () => {
    const none = setup({ urls: [] })
    none.outbox.send(reply())
    expect(none.sent.map(message => message.id)).toEqual(['m1'])
    const missing = setup()
    missing.outbox.send(reply({ ticketId: 'other' }))
    expect(missing.sent.map(message => message.id)).toEqual(['m1'])
  })
  it('withdraws the primary receipt and every copy it queued', () => {
    const { outbox, withdrawn } = setup()
    outbox.withdraw('m1')
    expect(withdrawn).toEqual(['m1', key('forward', 'm1', 'ops'), key('forward', 'm1', 'dev')])
  })
  it('delegates the status of a receipt to the wrapped Outbox', () => {
    const inner = { send: () => {}, status: vi.fn(() => 'sent' as const), withdraw: () => {} }
    const plain = new ForwardingOutbox(inner, { store: {} as never, sources: {} as never })
    expect(plain.status('m1')).toBe('sent')
    expect(inner.status).toHaveBeenCalledWith('m1')
  })
})
