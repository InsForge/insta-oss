// Client-side template catalog filtering (plan 07 H.3, I): the bundled catalog is small, so the
// gallery and the deploy picker search and group it in the browser instead of adding query
// parameters the cloud's `GET /templates` does not have. Pure, so both views share one rule.

export interface CatalogItem {
  code: string
  name: string
  tagline?: string
  category?: string
  tags?: string[]
}

/** Every whitespace-separated term must appear in the code, name, tagline or one tag. */
export function matchesTemplate(t: CatalogItem, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const hay = [t.code, t.name, t.tagline ?? '', ...(t.tags ?? [])].join(' ').toLowerCase()
  return terms.every((term) => hay.includes(term))
}

export const ALL_CATEGORIES = 'all'

/** `category === 'all'` keeps everything; the search runs after the category filter. */
export function filterTemplates<T extends CatalogItem>(items: T[], query: string, category: string = ALL_CATEGORIES): T[] {
  return items.filter((t) => (category === ALL_CATEGORIES || (t.category ?? '') === category) && matchesTemplate(t, query))
}

export interface CategoryCount { key: string; count: number }

/** The category rail: `all` first with the total, then each category by count then name. */
export function categoryCounts(items: CatalogItem[]): CategoryCount[] {
  const counts = new Map<string, number>()
  for (const t of items) {
    const key = t.category ?? ''
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const rest = [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => (b.count - a.count) || a.key.localeCompare(b.key))
  return [{ key: ALL_CATEGORIES, count: items.length }, ...rest]
}
