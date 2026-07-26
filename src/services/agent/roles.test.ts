import { describe, expect, it } from 'vitest'
import { JSON_ROLES, ROLE_TEMPERATURES, resolveRoleModel } from './roles'

describe('resolveRoleModel', () => {
  const fallback = 'qwen2.5-coder'

  it('uses the configured model when there is one', () => {
    expect(resolveRoleModel({ planner: 'qwen3:30b' }, 'planner', fallback)).toBe('qwen3:30b')
  })

  it('inherits the chat model when the role is blank, whitespace, or absent', () => {
    // Blank is the normal configuration, not an error: most people run one model.
    expect(resolveRoleModel({ planner: '' }, 'planner', fallback)).toBe(fallback)
    expect(resolveRoleModel({ planner: '   ' }, 'planner', fallback)).toBe(fallback)
    expect(resolveRoleModel({}, 'planner', fallback)).toBe(fallback)
    expect(resolveRoleModel(undefined, 'planner', fallback)).toBe(fallback)
  })

  it('trims a configured model', () => {
    expect(resolveRoleModel({ executor: '  qwen3:8b  ' }, 'executor', fallback)).toBe('qwen3:8b')
  })

  it('resolves each role independently', () => {
    const roles = { planner: 'big', executor: '' }
    expect(resolveRoleModel(roles, 'planner', fallback)).toBe('big')
    expect(resolveRoleModel(roles, 'executor', fallback)).toBe(fallback)
    expect(resolveRoleModel(roles, 'validator', fallback)).toBe(fallback)
  })
})

describe('role constants', () => {
  it('gives every role a temperature', () => {
    expect(Object.keys(ROLE_TEMPERATURES).sort()).toEqual([
      'executor',
      'planner',
      'postValidator',
      'validator',
    ])
  })

  it('samples the executor most conservatively', () => {
    // A model writing a patch should not be creative about it.
    const others = [
      ROLE_TEMPERATURES.planner,
      ROLE_TEMPERATURES.validator,
      ROLE_TEMPERATURES.postValidator,
    ]
    expect(others.every((t) => t > ROLE_TEMPERATURES.executor)).toBe(true)
  })

  it('constrains every JSON-producing role but not the executor', () => {
    // The executor emits tool calls and prose, so forcing JSON would break it.
    expect(JSON_ROLES.has('executor')).toBe(false)
    expect(JSON_ROLES.has('planner')).toBe(true)
    expect(JSON_ROLES.has('validator')).toBe(true)
    expect(JSON_ROLES.has('postValidator')).toBe(true)
  })
})
