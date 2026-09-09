export const meta = {
  name: 'insta-oss-serverless-integrate',
  description: 'Merge the package branches into feat/single-node-serverless in contract order, verifying after each merge, then run the Docker suites and fix what breaks',
  phases: [
    { title: 'Merge', detail: 'one agent merges the whole ladder, verifying at each step' },
    { title: 'Docker', detail: 'the integration Docker suites, run serially' },
    { title: 'Review', detail: 'three reviewers attack the assembled branch' },
    { title: 'Fix', detail: 'apply confirmed findings' },
  ],
}

const WT = '/Users/gary/projects/instacloud/insta-oss/.claude/worktrees/serverless'

const CONTEXT = [
  'Repo InsForge/insta-oss. You work in the INTEGRATION worktree ' + WT + ' on branch feat/single-node-serverless. This worktree is yours for this task; no other agent is writing to it.',
  '',
  'Read first: plans/impl/09-integration-order.md (the merge ladder, the per-merge verification, the Docker sequence, the conflict rules), plans/impl/00-contract.md (types, config, hooks, routes, region markers, ownership), and each package plan as you reach its merge.',
  '',
  'The package branches, all based on the scaffold commit 906c6b6, are in sibling worktrees under /Users/gary/projects/instacloud/insta-oss/.claude/worktrees/. Read each branch with plain git (log, show, diff) from this worktree; never edit a sibling worktree. Branch names are wp1/identity-config-2, wp2/router-2, wp3/scheduler-2, wp4/branching-2, wp5/templates-parity-2, wp6/packaging-2, wp7/dashboard-2, wp8/docs-e2e-2. Some may be incomplete or absent: check `git log --oneline 906c6b6..<branch>` first and skip a branch with no commits, recording it as not landed.',
  '',
  'COMMIT DISCIPLINE: this session is interrupted by usage limits roughly every fifteen minutes and anything uncommitted is lost. Merge one branch at a time and commit the merge (plus any fixup) before starting the next. Never leave a conflicted or half-fixed tree between tool calls for longer than necessary. If you run out of room, stop at a committed state and report exactly where you are.',
  '',
  'Conflict rules are in 09 section "Conflict rules at merge": a conflict inside a region takes the region owner side and the other side is re-applied inside its own region; a conflict at a 7.2 edit point takes WP5 skeleton; a conflict in src/types.ts takes the contract text; a conflict in test/server.test.ts outside a region keeps the existing assertion unless the merging package plan lists that edit.',
  '',
  'Rules: no endpoint the cloud lacks; no competitor names in code or docs; no em dashes in docs copy; TypeScript strict. Every commit message ends with the line: Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>',
  '',
  'Return raw JSON only: your final message is consumed by a script.',
].join('\n')

phase('Merge')
const merged = await agent(
  CONTEXT + '\n\nYou are the INTEGRATOR. Work the merge ladder of 09-integration-order.md in order: WP1, WP5, WP4, WP3, WP2, WP6, WP7, WP8. For each branch: merge it into feat/single-node-serverless (no fast-forward, `git merge --no-ff <branch>`), resolve conflicts by the conflict rules, then run npm run typecheck, npm run lint and npm test and fix whatever the merge broke, then commit. Do NOT run Docker tests in this phase (a later phase does). After each merge also do that merge section\'s non-Docker verification steps from 09. If a branch is missing or so incomplete that merging it would break the tree beyond a quick fix, skip it, leave the tree green, and record it in notLanded with what is missing. Return JSON describing the final state.',
  { label: 'merge-ladder', phase: 'Merge', effort: 'xhigh', schema: { type: 'object', properties: {
    headSha: { type: 'string' },
    landed: { type: 'array', items: { type: 'string' } },
    notLanded: { type: 'array', items: { type: 'object', properties: { wp: { type: 'string' }, why: { type: 'string' } }, required: ['wp', 'why'] } },
    tests: { type: 'string' },
    conflictsResolved: { type: 'array', items: { type: 'string' } },
    brokenByMerge: { type: 'array', items: { type: 'string' } },
    remaining: { type: 'array', items: { type: 'string' } },
  }, required: ['headSha', 'landed', 'notLanded', 'tests', 'conflictsResolved', 'brokenByMerge', 'remaining'] } }
)
log('merge ladder: landed ' + ((merged && merged.landed) || []).join(', ') + ' | head ' + (merged ? merged.headSha : '?'))

phase('Docker')
const docker = await agent(
  CONTEXT + '\n\nYou are the INTEGRATOR running the Docker suites on the assembled branch. Follow 09-integration-order.md section "Docker test sequence" exactly: run each suite ALONE with `RUN_DOCKER_TESTS=1 npx vitest run <file>`, in the listed order, cleaning up containers between files (`docker ps -aq --filter name=io- | xargs -r docker rm -f`, and remove the garage volumes where the sequence says so), each with its own realpath tmp INSTA_OSS_DATA_DIR and INSTA_OSS_SCHEDULER=0 unless the suite tests sleep. Skip a suite whose file does not exist (a package that did not land) and record it. For every failure: diagnose it, fix the code (not the test, unless the test is provably wrong), re-run that suite until it passes, and commit each fix separately. Report honestly: a suite you could not get green must be listed as failing with the diagnosis, never described as passing.',
  { label: 'docker-suites', phase: 'Docker', effort: 'xhigh', schema: { type: 'object', properties: {
    headSha: { type: 'string' },
    passed: { type: 'array', items: { type: 'string' } },
    failed: { type: 'array', items: { type: 'object', properties: { suite: { type: 'string' }, diagnosis: { type: 'string' } }, required: ['suite', 'diagnosis'] } },
    skipped: { type: 'array', items: { type: 'string' } },
    fixes: { type: 'array', items: { type: 'string' } },
  }, required: ['headSha', 'passed', 'failed', 'skipped', 'fixes'] } }
)
log('docker: ' + ((docker && docker.passed) || []).length + ' passed, ' + ((docker && docker.failed) || []).length + ' failed')

phase('Review')
const LENSES = [
  { key: 'contract', prompt: 'Verify the assembled branch against plans/impl/00-contract.md: every route in section 9 exists with the documented shape and nothing beyond it (list every route the daemon now serves by reading src/server.ts and compare); types match section 4; every hook in 7.1 has a real body or a justified identity; region markers intact; no endpoint the cloud lacks (spot-check the five most suspicious against insta-platform origin/main openapi.yaml and src/server.ts at /Users/gary/projects/insforge-repo/insta-platform).' },
  { key: 'correctness', prompt: 'Attack the merged implementation for correctness: read src/router/, src/scheduler.ts, the postgres fork path, and the engine hook bodies, and hunt for races, unreleased locks, leaked timers or sockets, wrong docker flags, error paths that leave state lying, crash-recovery holes, and wake or sleep paths that can strand a service. Report only defects you can trace to a line.' },
  { key: 'regression', prompt: 'Hunt for regressions against the pre-branch behaviour: run npm test and read the diff of test/server.test.ts against 906c6b6 for assertions that were weakened or deleted rather than legitimately updated; check that local mode still behaves as today (no auth, localhost, today startup lines) by reading the code paths and booting the daemon on a spare port; check nothing in COMPATIBILITY.md is now false.' },
]
const findings = (await parallel(LENSES.map(l => () => agent(
  CONTEXT + '\n\nYou are an independent REVIEWER of the assembled branch (read-only: you may run tests and boot the daemon on a spare port, but do not edit or commit). ' + l.prompt + '\n\nReturn concrete findings with file:line evidence and the exact fix. Report a finding only when you can point at the evidence.',
  { label: 'review:' + l.key, phase: 'Review', effort: 'high', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { problem: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'major', 'minor'] } }, required: ['problem', 'evidence', 'fix', 'severity'] } } }, required: ['findings'] } }
)))).filter(Boolean).flatMap(r => r.findings)
log(findings.length + ' review findings (' + findings.filter(f => f.severity === 'blocker').length + ' blockers)')

phase('Fix')
let fixed = null
const actionable = findings.filter(f => f.severity !== 'minor')
if (actionable.length) {
  fixed = await agent(
    CONTEXT + '\n\nYou are the INTEGRATOR applying review findings. Apply every blocker and major below (verify each against the code first; reject with a one-line reason only if the evidence is wrong). Commit after each fix. Then run npm run typecheck, npm run lint, npm test, and re-run any Docker suite your fixes could affect. Return JSON.\n\nFINDINGS:\n' + JSON.stringify(actionable, null, 1),
    { label: 'fix', phase: 'Fix', effort: 'xhigh', schema: { type: 'object', properties: { headSha: { type: 'string' }, applied: { type: 'array', items: { type: 'string' } }, rejected: { type: 'array', items: { type: 'string' } }, tests: { type: 'string' } }, required: ['headSha', 'applied', 'rejected', 'tests'] } }
  )
}

return {
  landed: merged ? merged.landed : [], notLanded: merged ? merged.notLanded : [],
  mergeConflicts: merged ? merged.conflictsResolved : [],
  dockerPassed: docker ? docker.passed : [], dockerFailed: docker ? docker.failed : [], dockerSkipped: docker ? docker.skipped : [],
  findings: findings.length, blockers: findings.filter(f => f.severity === 'blocker').length,
  minorsLeft: findings.filter(f => f.severity === 'minor').map(f => f.problem),
  applied: fixed ? fixed.applied.length : 0, rejected: fixed ? fixed.rejected : [],
  headSha: fixed ? fixed.headSha : (docker ? docker.headSha : (merged ? merged.headSha : null)),
  tests: fixed ? fixed.tests : (merged ? merged.tests : null),
}
