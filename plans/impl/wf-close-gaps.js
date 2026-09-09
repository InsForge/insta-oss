export const meta = {
  name: 'insta-oss-close-gaps',
  description: 'Close the remaining open gaps: multi-arch template images, the three missing container suites, and the accumulated small findings',
  phases: [
    { title: 'Multiarch', detail: 'publish-ready arm64 template images and a verified release path' },
    { title: 'Suites', detail: 'the three container suites the integration order names but nobody wrote' },
    { title: 'Findings', detail: 'the small defects and doc corrections from both VPS runs' },
  ],
}

const WT = '/Users/gary/projects/instacloud/insta-oss/.claude/worktrees/serverless'

const CONTEXT = [
  'Repo InsForge/insta-oss, branch feat/single-node-serverless, draft PR #97. You work in ' + WT + ' with plain git (no -C, no cd outside it).',
  '',
  'CONCURRENCY WARNING: another agent is testing on a live EC2 box and may commit to this same worktree while you work. Before editing any file, re-read it. Commit after every change so your work cannot be swept away, and if you find your edit gone, re-apply it rather than assuming you already did it. Never use git reset, git rebase, git checkout of a whole path, or force anything: another agent loses work if you rewrite history.',
  '',
  'STATE: all eight work packages are merged and the tree is green at 503 tests across 30 files. Two real VPS runs (a t3.small Ubuntu box, and a Docker-in-Docker Linux host) plus a macOS smoke have already fixed nine real defects and five security issues. Read plans/impl/00-contract.md, plans/2026-09-08-single-node-serverless-spec.md, plans/impl/09-integration-order.md, COMPATIBILITY.md and the docs/self-hosting pages.',
  '',
  'KEEP THE TREE GREEN: run npm run typecheck, npm run lint and npm test before each commit where practical and always before your last. Never weaken or delete an assertion to make something pass.',
  '',
  'Rules: no endpoint the cloud lacks; minimal dependencies; no competitor names in code or docs; no em dashes in docs copy; TypeScript strict. Every commit message ends with the line: Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>',
  '',
  'Return raw JSON only. Report honestly: anything you could not verify is listed as unverified, never as done.',
].join('\n')

phase('Multiarch')
const multiarch = await agent(
  CONTEXT + '\n\nYou are fixing the ARM64 TEMPLATE GAP, which is open gap number one on the PR. Six of the eight bundled template images are published amd64-only, while install.sh and the docs promise aarch64 works, so on an arm64 box most templates cannot deploy. A CI change was made earlier in this branch but has never been verified.'
    + '\n\nDo this properly: read .github/workflows/templates-build-images.yml and every templates/*/Dockerfile, and work out for each whether it can actually cross-build for linux/arm64. Some pin amd64-only upstream binaries or base images; for those the honest answer may be that the template is amd64-only and the catalog must say so rather than the docs promising otherwise. Then PROVE the ones that can: this machine is arm64, so build each candidate locally for linux/arm64 with buildx and confirm it produces an image that starts. Do not push anything to a registry.'
    + '\n\nDeliver: a workflow that builds and publishes multi-arch where the template supports it, an explicit per-template record of which architectures it supports, a manifest or catalog field so a user on arm64 is told before they deploy rather than after it fails, and docs that match reality. If a template genuinely cannot go arm64, say so in its README and in the catalog rather than pretending.',
  { label: 'multiarch', phase: 'Multiarch', effort: 'xhigh', schema: { type: 'object', properties: {
    headSha: { type: 'string' },
    perTemplate: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, arm64: { type: 'string', enum: ['builds', 'cannot', 'untested'] }, evidence: { type: 'string' } }, required: ['code', 'arm64', 'evidence'] } },
    changes: { type: 'array', items: { type: 'string' } },
    unverified: { type: 'array', items: { type: 'string' } },
  }, required: ['headSha', 'perTemplate', 'changes', 'unverified'] } }
)
log('multiarch: ' + (multiarch ? multiarch.perTemplate.filter(t => t.arm64 === 'builds').length + ' templates build arm64' : 'returned nothing'))

phase('Suites')
const suites = await agent(
  CONTEXT + '\n\nYou are writing THE THREE CONTAINER SUITES that plans/impl/09-integration-order.md names in its Docker sequence but nobody ever wrote. They are open gap number three on the PR, and each covers a path that only real Docker exercises.'
    + '\n\n1. test/fork.int.test.ts: the Postgres fork, run twice, once with INSTA_OSS_FORK=auto (which on this APFS laptop takes the reflink path) and once with INSTA_OSS_FORK=basebackup. Assert the recorded method matches the mode, that the fork carries seeded data, that writes on the fork never reach the parent, that the parent is untouched while it happens, and that a fork of a sleeping parent works without waking it if that is the contract. Assert the strict mode too: INSTA_OSS_FORK=reflink must refuse rather than silently copy when reflinks are unavailable, which no test has ever covered.'
    + '\n2. test/datadir-migrate.int.test.ts: a real pre-scaffold data directory, with legacy named volumes and the old container names, migrated by src/datadir-migrate.ts. Build the legacy shape for real, run the migration, and assert the data survives, the services still start, and re-running the migration is a no-op.'
    + '\n3. test/router.int.test.ts: the router lanes against real containers, which today are covered only by fake suites even though test/template-deploy.int.test.ts explicitly says this suite is what covers the HTTP lane it bypasses. Assert Host-based routing to a real container, hold-and-wake on a sleeping service, the pg-wire lane end to end with a real psql client through SNI, that a user-stopped service answers a clear error rather than waking, and that nothing is published beyond loopback.'
    + '\n\nRun each suite yourself with RUN_DOCKER_TESTS=1, one at a time, cleaning containers between runs. If a suite finds a real defect, fix the code rather than softening the test, and commit the fix separately from the test. These suites must be runnable in CI on a Linux runner, so avoid anything that only works on macOS: where a behaviour genuinely differs by platform, branch on the detected capability rather than skipping.',
  { label: 'suites', phase: 'Suites', effort: 'xhigh', schema: { type: 'object', properties: {
    headSha: { type: 'string' },
    suites: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, tests: { type: 'number' }, result: { type: 'string', enum: ['green', 'red', 'not-written'] }, notes: { type: 'string' } }, required: ['file', 'tests', 'result', 'notes'] } },
    defectsFound: { type: 'array', items: { type: 'string' } },
    unverified: { type: 'array', items: { type: 'string' } },
  }, required: ['headSha', 'suites', 'defectsFound', 'unverified'] } }
)
log('suites: ' + (suites ? suites.suites.filter(s => s.result === 'green').length + '/3 green, ' + suites.defectsFound.length + ' defects' : 'returned nothing'))

phase('Findings')
const findings = await agent(
  CONTEXT + '\n\nYou are closing the SMALL FINDINGS that two VPS runs left behind. Each is small on its own; together they are the difference between a branch that works and one a stranger trusts. Verify each against the code before changing anything, and reject with a reason any whose evidence does not hold.'
    + '\n\nFrom the EC2 run: (a) a successful install prints a scary "the edge has not issued a certificate yet" warning because its wait is shorter than a first ACME issuance, so a healthy install looks broken; (b) the documented 2 GiB RAM and 15 GiB disk minimums are never enforced or even checked by install.sh; (c) a storage service reports runtime "stopped" when it has no container at all, while the contract vocabulary has "none" for exactly that; (d) COMPATIBILITY.md claims a policy command that the current CLI does not have, and should say the decision is set through the API or the dashboard; (e) on a public box with an auto domain, certificate transparency publishes every hostname within minutes and internet scanners then wake services, so an operator watching docker ps thinks scale-to-zero is broken: this needs an honest paragraph in docs/self-hosting/sleep.mdx, since it is real behaviour and not a bug.'
    + '\n\nFrom the Linux run: (f) e2e/server-smoke.sh still dirties the operator checkout the way local-smoke.sh did before it was fixed, because it creates a project from the caller cwd and writes its log into the repo; fix it the same way local-smoke.sh was fixed.'
    + '\n\nThen do a final pass of your own over README.md, COMPATIBILITY.md and every docs/self-hosting page, checking each concrete claim against the code as it now stands after roughly a dozen fixes, and correct anything that has drifted. Finish with typecheck, lint, the full fake suite and build:ui green, the working tree clean, and everything pushed to the branch.',
  { label: 'findings', phase: 'Findings', effort: 'xhigh', schema: { type: 'object', properties: {
    headSha: { type: 'string' },
    fixed: { type: 'array', items: { type: 'string' } },
    rejected: { type: 'array', items: { type: 'string' } },
    docClaimsCorrected: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    pushed: { type: 'boolean' },
  }, required: ['headSha', 'fixed', 'rejected', 'docClaimsCorrected', 'tests', 'pushed'] } }
)

return {
  multiarch: multiarch ? { perTemplate: multiarch.perTemplate, changes: multiarch.changes, unverified: multiarch.unverified } : null,
  suites: suites ? { suites: suites.suites, defects: suites.defectsFound, unverified: suites.unverified } : null,
  findings: findings ? { fixed: findings.fixed, rejected: findings.rejected, docs: findings.docClaimsCorrected, tests: findings.tests, pushed: findings.pushed } : null,
}
