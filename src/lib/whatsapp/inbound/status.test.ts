import { describe, it, expect } from 'vitest'
import { isValidStatusTransition } from './status'

describe('isValidStatusTransition', () => {
  it('refuses regressing down the ladder', () => {
    expect(isValidStatusTransition('delivered', 'sent')).toBe(false)
  })

  it('allows moving forward on the ladder', () => {
    expect(isValidStatusTransition('sent', 'read')).toBe(true)
  })

  it('allows failed only from pending or sent', () => {
    expect(isValidStatusTransition('pending', 'failed')).toBe(true)
    expect(isValidStatusTransition('sent', 'failed')).toBe(true)
    expect(isValidStatusTransition('delivered', 'failed')).toBe(false)
    expect(isValidStatusTransition('read', 'failed')).toBe(false)
  })

  it('refuses unknown incoming status', () => {
    expect(isValidStatusTransition('sent', 'bogus')).toBe(false)
  })

  it('accepts any ladder status when current is unknown', () => {
    expect(isValidStatusTransition('bogus', 'sent')).toBe(true)
    expect(isValidStatusTransition('bogus', 'read')).toBe(true)
  })
})
