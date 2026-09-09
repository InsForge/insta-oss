export const meta = {
  name: 'insta-oss-serverless-implement',
  description: 'Implement the 8 work packages in parallel worktrees from the scaffold commit, each reviewed and fixed before hand-off to the integrator',
  phases: [
    { title: 'Implement', detail: 'one implementer per package in its own worktree' },
    { title: 'Review', detail: 'independent reviewer per package against its plan' },
    { title: 'Fix', detail: 'implementer applies review findings' },
  ],
}

const WT = '/Users/gary/projects/instacloud/insta-oss/.claude/worktrees/serverless'
const BASE = '906c6b6'
const CONTEXT = [
  'Repo InsForge/insta-oss. The integration branch is feat/single-node-serverless at ' + BASE + ' (the scaffold commit) in ' + WT + '.',
  'You work in your OWN git worktree (the harness created it for you: run git rev-parse --show-toplevel and stay inside it; never touch ' + WT + ' itself). Your worktree starts from ' + BASE + '. Create a branch named wp<N>/<slug> and commit there. RESUME RULE: a previous run of this package was interrupted. A sibling worktree /Users/gary/projects/instacloud/insta-oss/.claude/worktrees/wf_6132847f-f47-<N> (N = your package number) may hold partial work: a branch wp<N>/<slug> with zero or more commits, plus uncommitted files. FIRST check it: if it exists, cd there, run git status and git log --oneline ' + BASE + '..HEAD, read what was done, then bring it into YOUR worktree (git fetch of the branch if committed; copy the uncommitted files over otherwise), verify each piece against the plan, and continue from there instead of starting over. If your branch name is already taken by that sibling, name yours wp<N>/<slug>-2. Never delete or modify the sibling worktree.',
  'Read first, in order: plans/2026-09-08-single-node-serverless-spec.md (the design), plans/impl/00-contract.md (the integration contract: types, config, engine hooks, routes, region markers, ownership rules in 1.2/1.3), plans/impl/09-integration-order.md, then YOUR package plan. Other package plans are context only.',
  'OWNERSHIP IS STRICT: edit only the files your plan owns, and inside shared files (src/engine.ts, src/server.ts, src/types.ts, src/state.ts, src/main.ts, src/manageddb.ts, test/server.test.ts, test/fakes.ts, ui/src/api.ts, .github/workflows/ci.yml) write only inside YOUR region markers or at the 7.2 edit points your plan names. A hook body you own replaces the identity the scaffold left in your region. If you need a contract change, record it in your return value under contractChangesNeeded and do the smallest local thing that keeps you unblocked; never change another package region.',
  'Tests: the fake-adapter suites are the contract suite and must stay green: npm run typecheck, npm run lint, npm test (int tests are excluded unless RUN_DOCKER_TESTS=1). Add the tests your plan lists. Do NOT run Docker integration tests (*.int.test.ts) and do NOT start containers: other implementers run concurrently and container names collide. You may write new *.int.test.ts files for the integrator to run.',
  'Rules: no endpoint the cloud lacks (every route must be in contract section 9 with cloud evidence); minimal deps (yaml@^2 is the only pre-approved addition, WP5 only); no competitor names in code or docs; no em dashes in docs copy; TypeScript strict; commits end with the line: Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>',
  'Finish with everything committed on your branch (several commits are fine). Return raw JSON only: your final message is consumed by a script.',
].join('\n')

const WPS = [
  { n: 1, slug: 'identity-config', plan: 'plans/impl/01-identity-config.md' },
  { n: 2, slug: 'router', plan: 'plans/impl/02-router.md' },
  { n: 3, slug: 'scheduler', plan: 'plans/impl/03-scheduler.md' },
  { n: 4, slug: 'branching', plan: 'plans/impl/04-branching.md' },
  { n: 5, slug: 'templates-parity', plan: 'plans/impl/05-templates-parity.md' },
  { n: 6, slug: 'packaging', plan: 'plans/impl/06-packaging.md' },
  { n: 7, slug: 'dashboard', plan: 'plans/impl/07-dashboard.md' },
  { n: 8, slug: 'docs-e2e', plan: 'plans/impl/08-docs-e2e.md' },
]

const IMPL_SCHEMA = { type: 'object', properties: {
  worktree: { type: 'string' }, branch: { type: 'string' }, headSha: { type: 'string' },
  filesChanged: { type: 'array', items: { type: 'string' } },
  tests: { type: 'string', description: 'typecheck/lint/npm test results with counts' },
  doneWhen: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, status: { type: 'string', enum: ['done', 'partial', 'not-done'] }, note: { type: 'string' } }, required: ['item', 'status'] } },
  contractChangesNeeded: { type: 'array', items: { type: 'string' } },
  dockerTestsForIntegrator: { type: 'array', items: { type: 'string' } },
  notes: { type: 'array', items: { type: 'string' } },
}, required: ['worktree', 'branch', 'headSha', 'filesChanged', 'tests', 'doneWhen', 'contractChangesNeeded', 'dockerTestsForIntegrator', 'notes'] }

const REVIEW_SCHEMA = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { problem: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'major', 'minor'] } }, required: ['problem', 'evidence', 'fix', 'severity'] } }, verdict: { type: 'string', enum: ['ready', 'needs-fixes'] } }, required: ['findings', 'verdict'] }

phase('Implement')
const results = await pipeline(WPS,
  (w) => agent(
    CONTEXT + '\n\nYou are the IMPLEMENTER of WP' + w.n + ' (' + w.slug + '). Your plan: ' + w.plan + '. Implement it completely: every file, every algorithm step, every listed test, until every item of its Done-when checklist is done or you have a concrete reason it cannot be. Work incrementally with commits. Before returning, re-read the Done-when list and grade each item honestly.',
    { label: 'impl:wp' + w.n + '-' + w.slug, phase: 'Implement', schema: IMPL_SCHEMA, effort: 'xhigh', isolation: 'worktree' }
  ),
  (impl, w) => {
    if (!impl) { log('WP' + w.n + ' implementer returned nothing'); return null }
    log('WP' + w.n + ' implemented at ' + impl.headSha + ' in ' + impl.worktree + ' (' + impl.doneWhen.filter(d => d.status === 'done').length + '/' + impl.doneWhen.length + ' done)')
    return agent(
      CONTEXT + '\n\nYou are the independent REVIEWER of WP' + w.n + ' (' + w.slug + '). The implementer worked in the worktree ' + impl.worktree + ' on branch ' + impl.branch + ' (head ' + impl.headSha + '); you have READ access to it: cd there to read files and run npm run typecheck, npm run lint and npm test, but do NOT edit or commit there, and do NOT run Docker tests. Review against ' + w.plan + ' and 00-contract.md: (1) every Done-when item, is it really done? (2) ownership: run git diff ' + BASE + '..' + impl.headSha + ' --stat and flag any edit outside the package\'s owned files or region markers; (3) contract: every route matches section 9 shapes; every type matches section 4; hook bodies match 7.1 signatures; (4) correctness: read the core algorithm and try to break it (races, error paths, crash recovery, resource leaks, wrong docker flags); (5) tests: are the listed tests present and do they assert the behaviour, not just run it? Implementer self-report for context: ' + JSON.stringify({ doneWhen: impl.doneWhen, notes: impl.notes, contractChangesNeeded: impl.contractChangesNeeded }) + '\n\nReturn concrete findings with file:line evidence and the exact fix. Verdict ready only if there are no blockers or majors.',
      { label: 'review:wp' + w.n, phase: 'Review', schema: REVIEW_SCHEMA, effort: 'high' }
    ).then(review => ({ impl, review }))
  },
  (r, w) => {
    if (!r) return null
    const { impl, review } = r
    const actionable = review ? review.findings.filter(f => f.severity !== 'minor') : []
    log('WP' + w.n + ' review: ' + (review ? review.verdict : 'none') + ', ' + (review ? review.findings.length : 0) + ' findings (' + actionable.length + ' blocker/major)')
    if (!review || review.verdict === 'ready') return { w, impl, review, fix: null }
    return agent(
      CONTEXT + '\n\nYou are the IMPLEMENTER of WP' + w.n + ' (' + w.slug + ') again. Your worktree is ' + impl.worktree + ' on branch ' + impl.branch + ' (cd there; it is yours). Apply these review findings (verify each first; reject with a one-line reason only if the evidence is wrong), re-run typecheck, lint and npm test, commit. Return JSON.\n\nFINDINGS:\n' + JSON.stringify(review.findings, null, 1),
      { label: 'fix:wp' + w.n, phase: 'Fix', effort: 'high', schema: { type: 'object', properties: { headSha: { type: 'string' }, applied: { type: 'array', items: { type: 'string' } }, rejected: { type: 'array', items: { type: 'string' } }, tests: { type: 'string' } }, required: ['headSha', 'applied', 'rejected', 'tests'] } }
    ).then(fix => ({ w, impl, review, fix }))
  }
)

return results.filter(Boolean).map(r => ({
  wp: r.w.n, slug: r.w.slug, worktree: r.impl.worktree, branch: r.impl.branch,
  headSha: r.fix ? r.fix.headSha : r.impl.headSha,
  done: r.impl.doneWhen.filter(d => d.status === 'done').length + '/' + r.impl.doneWhen.length,
  notDone: r.impl.doneWhen.filter(d => d.status !== 'done').map(d => d.item + ': ' + (d.note || d.status)),
  reviewVerdict: r.review ? r.review.verdict : 'none',
  findings: r.review ? r.review.findings.length : 0,
  fixApplied: r.fix ? r.fix.applied.length : 0, fixRejected: r.fix ? r.fix.rejected : [],
  contractChangesNeeded: r.impl.contractChangesNeeded, dockerTests: r.impl.dockerTestsForIntegrator, notes: r.impl.notes,
}))
