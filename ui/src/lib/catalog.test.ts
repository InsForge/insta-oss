import { describe, expect, it } from 'vitest'
import { ALL_CATEGORIES, categoryCounts, filterTemplates, matchesTemplate, type CatalogItem } from './catalog'

const items: CatalogItem[] = [
  { code: 'n8n', name: 'n8n', tagline: 'Workflow automation', category: 'automation', tags: ['workflow', 'low-code'] },
  { code: 'codex', name: 'Codex', tagline: 'Coding agent in a container', category: 'ai-agent', tags: ['agent'] },
  { code: 'claude-code', name: 'Claude Code', tagline: 'Terminal coding agent', category: 'ai-agent', tags: ['agent', 'cli'] },
  { code: 'dsh', name: 'Dsh', tagline: 'Static site', tags: [] },
]

describe('matchesTemplate', () => {
  it('matches on code, name, tagline and tags', () => {
    expect(matchesTemplate(items[0], 'n8n')).toBe(true)
    expect(matchesTemplate(items[0], 'Workflow')).toBe(true)
    expect(matchesTemplate(items[0], 'low-code')).toBe(true)
    expect(matchesTemplate(items[0], 'postgres')).toBe(false)
  })

  it('requires every term and ignores case and padding', () => {
    expect(matchesTemplate(items[2], 'coding agent')).toBe(true)
    expect(matchesTemplate(items[2], '  CLAUDE   cli ')).toBe(true)
    expect(matchesTemplate(items[2], 'claude n8n')).toBe(false)
  })

  it('treats a blank query as a match', () => {
    expect(matchesTemplate(items[3], '')).toBe(true)
    expect(matchesTemplate(items[3], '   ')).toBe(true)
  })
})

describe('filterTemplates', () => {
  it('filters by category then query', () => {
    expect(filterTemplates(items, '', 'ai-agent').map((t) => t.code)).toEqual(['codex', 'claude-code'])
    expect(filterTemplates(items, 'terminal', 'ai-agent').map((t) => t.code)).toEqual(['claude-code'])
    expect(filterTemplates(items, '', 'automation').map((t) => t.code)).toEqual(['n8n'])
  })

  it('keeps everything for the all category', () => {
    expect(filterTemplates(items, '').length).toBe(4)
    expect(filterTemplates(items, '', ALL_CATEGORIES).length).toBe(4)
  })
})

describe('categoryCounts', () => {
  it('puts all first with the total, then categories by count', () => {
    expect(categoryCounts(items)).toEqual([
      { key: ALL_CATEGORIES, count: 4 },
      { key: 'ai-agent', count: 2 },
      { key: 'automation', count: 1 },
    ])
  })

  it('skips rows without a category and handles an empty catalog', () => {
    expect(categoryCounts([])).toEqual([{ key: ALL_CATEGORIES, count: 0 }])
  })
})
