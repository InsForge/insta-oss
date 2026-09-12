import { describe, expect, it } from 'vitest'
import type { MetricSeries } from '../api'
import { latestByInstance } from './metricSeries'

const s = (name: string, instance: string, points: Array<[number, number]>): MetricSeries =>
  ({ name, labels: { instance }, points }) as MetricSeries

describe('latestByInstance', () => {
  // The regression this exists for: the environment-wide Observability page keyed by the display
  // label, and `instanceLabel` maps BOTH of these containers to "postgres". One overwrote the
  // other, so a real, running service was absent from the cards and from every chart.
  it('keeps two containers whose labels collide', () => {
    const got = latestByInstance([
      s('cpu', 'io-demo-main-pg', [[1, 1.5]]),
      s('cpu', 'io-demo-main-pg-pg', [[1, 9.25]]),
    ], 'cpu')
    expect(got).toEqual({ 'io-demo-main-pg': 1.5, 'io-demo-main-pg-pg': 9.25 })
    expect(Object.keys(got)).toHaveLength(2)
  })

  it('takes the LAST point of each series', () => {
    expect(latestByInstance([s('cpu', 'io-demo-main-app-api', [[1, 1], [2, 2], [3, 7]])], 'cpu'))
      .toEqual({ 'io-demo-main-app-api': 7 })
  })

  it('selects only the named metric', () => {
    const series = [
      s('cpu', 'io-demo-main-app-api', [[1, 3]]),
      s('memory', 'io-demo-main-app-api', [[1, 4096]]),
    ]
    expect(latestByInstance(series, 'cpu')).toEqual({ 'io-demo-main-app-api': 3 })
    expect(latestByInstance(series, 'memory')).toEqual({ 'io-demo-main-app-api': 4096 })
  })

  it('skips a series with no points or no instance label', () => {
    expect(latestByInstance([
      s('cpu', 'io-demo-main-app-api', []),
      { name: 'cpu', labels: {}, points: [[1, 5]] } as MetricSeries,
    ], 'cpu')).toEqual({})
  })

  it('is empty for no series', () => {
    expect(latestByInstance([], 'cpu')).toEqual({})
  })
})
