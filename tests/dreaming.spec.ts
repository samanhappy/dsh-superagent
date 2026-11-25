import { describe, expect, it, vi } from 'vitest'
import { DREAMING_PROMPT, Dreaming } from '../src/app/dreaming.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema } from '../src/policy.ts'

const DAY = 24 * 3_600_000

function harness(overrides: { enabled?: boolean; intervalHours?: number; open?: boolean; configured?: boolean; closing?: boolean
  lastRun?: string; now?: number } = {}) {
  const values = new Map<string, unknown>()
  if (overrides.lastRun !== undefined) values.set(KV.dreaming.lastRun, overrides.lastRun)
  const relay = vi.fn()
  const host = {
    store: { get: (key: string) => values.get(key), set: (key: string, value: unknown) => { values.set(key, value) },
      tickets: { open: () => overrides.open ? [{ id: 't1' }] : [] } },
    sessions: { relay },
    settings: () => ({ eval: { dreaming: { enabled: overrides.enabled ?? true, intervalHours: overrides.intervalHours ?? 24 } } }),
    configured: () => overrides.configured ?? true,
    closing: () => overrides.closing ?? false,
    now: () => overrides.now ?? Date.parse('2026-11-25T00:00:00.000Z'),
  }
  return { dreaming: new Dreaming(host as never), relay, values }
}

describe('Dreaming', () => {
  it('relays the review to the main Session and records the run while the agent is idle', async () => {
    const { dreaming, relay, values } = harness()
    await dreaming.check()
    expect(relay).toHaveBeenCalledWith('dreaming:2026-11-25T00:00:00.000Z', DREAMING_PROMPT)
    expect(values.get(KV.dreaming.lastRun)).toBe('2026-11-25T00:00:00.000Z')
  })

  it('waits while a Ticket is open, and runs once it is idle again', async () => {
    const busy = harness({ open: true })
    await busy.dreaming.check()
    expect(busy.relay).not.toHaveBeenCalled()
    const idle = harness({ lastRun: new Date(Date.parse('2026-11-25T00:00:00.000Z') - DAY).toISOString() })
    await idle.dreaming.check()
    expect(idle.relay).toHaveBeenCalledTimes(1)
  })

  it('does not repeat a review within the configured interval, and runs it again after', async () => {
    const recent = harness({ lastRun: new Date(Date.parse('2026-11-25T00:00:00.000Z') - 3_600_000).toISOString() })
    await recent.dreaming.check()
    expect(recent.relay).not.toHaveBeenCalled()
    const due = harness({ lastRun: new Date(Date.parse('2026-11-25T00:00:00.000Z') - DAY).toISOString() })
    await due.dreaming.check()
    expect(due.relay).toHaveBeenCalledTimes(1)
  })

  it('stays quiet while disabled, unconfigured or closing', async () => {
    for (const options of [{ enabled: false }, { configured: false }, { closing: true }]) {
      const { dreaming, relay } = harness(options)
      await dreaming.check()
      expect(relay).not.toHaveBeenCalled()
    }
  })

  it('records one run when two checks overlap', async () => {
    const { dreaming, relay } = harness()
    await Promise.all([dreaming.check(), dreaming.check()])
    expect(relay).toHaveBeenCalledTimes(1)
  })

  it('persists lessons in prompts or merge requests, and never rewrites policy on its own', () => {
    expect(DREAMING_PROMPT).toContain('orchestrator_prompts_save')
    expect(DREAMING_PROMPT).toContain('merge request')
    expect(DREAMING_PROMPT).toContain('Never change policy')
    expect(DREAMING_PROMPT).toContain('Source is configured for')
    expect(DREAMING_PROMPT).not.toMatch(/智能问数|ai-data|sunmeng/)
  })
})

describe('Dreaming settings', () => {
  it('defaults to off, once a day', () => {
    expect(SettingsSchema.parse({}).eval.dreaming).toEqual({ enabled: false, intervalHours: 24 })
  })

  it('accepts an interval from 1 to 168 hours', () => {
    expect(SettingsSchema.parse({ eval: { dreaming: { enabled: true, intervalHours: 6 } } }).eval.dreaming)
      .toEqual({ enabled: true, intervalHours: 6 })
    expect(() => SettingsSchema.parse({ eval: { dreaming: { intervalHours: 0 } } })).toThrow()
    expect(() => SettingsSchema.parse({ eval: { dreaming: { intervalHours: 169 } } })).toThrow()
  })
})
