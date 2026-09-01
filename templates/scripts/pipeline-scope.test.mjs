// The three pieces that decide what a push rebuilds and what it must bump.
//
// The discover cases run the workflow step's shell VERBATIM under the same `set -euo pipefail`,
// and assert the exit status as well as the value. That distinction is the whole point: an earlier
// version computed `[]` correctly and still exited 1, which killed the step on exactly the
// "nothing to build" case the job exists to produce.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The workflow step runs from the repo root, so `find templates ...` resolves there, not here.
const repoRoot = join(root, '..');

// The body of the `pick` step, lifted from the workflow so the test cannot drift from it, with the
// two GitHub expressions it needs stubbed by the caller.
function pickStep() {
  const wf = yaml.load(readFileSync(join(repoRoot, '.github/workflows/templates-build-images.yml'), 'utf8'));
  return wf.jobs.discover.steps.find((s) => s.id === 'pick').run;
}

/** Run the step with a stubbed `git diff`, returning { json, status }. */
function discover({ changed = [], event = 'push', workflowChanged = false }) {
  const body = pickStep()
    .replaceAll('${{ github.event_name }}', event)
    .replaceAll('${{ github.event.before }}', 'BEFORE')
    .replaceAll('${{ github.sha }}', 'HEAD')
    // Stub git: `cat-file -e` resolves, and `diff` answers from the case's file list.
    .replace(/^set -euo pipefail$/m, `set -euo pipefail
git() {
  if [ "$1" = "cat-file" ]; then return 0; fi
  if [ "$1" = "diff" ]; then
    case "$*" in
      *templates-build-images.yml*) ${workflowChanged ? 'printf "%s\\n" .github/workflows/templates-build-images.yml' : 'true'} ;;
      *) printf '%s\\n' ${changed.map((c) => `'${c}'`).join(' ')} ;;
    esac
    return 0
  fi
  return 0
}`);
  const script = `${body}\necho "STATUS_OK"`;
  try {
    const out = execFileSync('bash', ['-c', script], {
      cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '/dev/null' },
    });
    const m = /building: (.*)/.exec(out);
    return { json: m ? m[1].trim() : null, ok: out.includes('STATUS_OK') };
  } catch {
    return { json: null, ok: false };
  }
}

describe('discover: which templates a push rebuilds', () => {
  it('exits 0 and emits [] when nothing buildable changed', () => {
    // The regression that made a README fix turn the workflow red.
    expect(discover({ changed: ['templates/claude-code/README.md'] })).toEqual({ json: '[]', ok: true });
  });

  it('exits 0 and emits [] for a template with no Dockerfile', () => {
    expect(discover({ changed: ['templates/n8n/insta.template.yaml'] })).toEqual({ json: '[]', ok: true });
  });

  it('exits 0 and emits [] for a top-level file under templates/', () => {
    expect(discover({ changed: ['templates/README.md'] })).toEqual({ json: '[]', ok: true });
  });

  it('exits 0 and emits [] for a scripts-only change', () => {
    expect(discover({ changed: ['templates/scripts/lint.mjs'] })).toEqual({ json: '[]', ok: true });
  });

  it('builds only the template whose image could have changed', () => {
    const out = discover({ changed: ['templates/claude-code/README.md', 'templates/hermes/insta.template.yaml'] });
    expect(out).toEqual({ json: '["hermes"]', ok: true });
  });

  it('builds every buildable template on workflow_dispatch', () => {
    const out = discover({ event: 'workflow_dispatch' });
    expect(out.ok).toBe(true);
    expect(JSON.parse(out.json)).toEqual(['9router', 'claude-code', 'codex', 'dsh', 'hermes', 'openclaw', 'pi']);
  });

  it('builds everything when the workflow itself changed', () => {
    const out = discover({ changed: ['templates/claude-code/README.md'], workflowChanged: true });
    expect(out.ok).toBe(true);
    expect(JSON.parse(out.json).length).toBeGreaterThan(1);
  });
});

// version-guard and lint are exercised end to end: both read the working tree, so driving them
// through their real entrypoints is closer to what CI runs than re-implementing their predicates.
function run(script, args = []) {
  try {
    return { out: execFileSync('node', [join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8' }), code: 0 };
  } catch (e) {
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

// lint discovers any directory under templates/, so a case is a directory written and removed.
function withTemplate(name, manifest, fn) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, 'insta.template.yaml'), yaml.dump(manifest));
    return fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('lint: sizing is the platform\'s, on every service type', () => {
  // logo: none so the fixture is otherwise CLEAN, and the positive case can assert exit 0.
  const base = { code: 'sizing-case', version: '1.0.0', maintainer: 'official', upstream: { pinned: 'v1' }, meta: { category: 'test', logo: 'none' } };
  const web = { type: 'web', image: 'docker.io/library/nginx:1.27', port: 80, healthcheck: '/' };

  it('refuses spec and a sized volume on a compute service', () => {
    for (const [field, extra] of [['spec', { spec: '1vcpu-1gb' }], ['volume', { volume: { size: 10 } }]]) {
      const r = withTemplate('sizing-case', { ...base, services: { web: { ...web, ...extra } } }, () => run('lint.mjs'));
      expect(r.code, `${field} should fail lint`).toBe(1);
      expect(r.out).toContain("the platform's to choose");
    }
  });

  // The postgres skip used to sit ABOVE these checks, so a managed DB could carry either field
  // through lint and only fail at publish. The platform refuses them on every type; so does this.
  it('refuses them on a postgres service too, despite the managed-service skip', () => {
    for (const extra of [{ spec: '1vcpu-1gb' }, { volume: { size: 10 } }]) {
      const r = withTemplate('sizing-case', { ...base, services: { web, db: { type: 'postgres', ...extra } } }, () => run('lint.mjs'));
      expect(r.code).toBe(1);
      expect(r.out).toContain("the platform's to choose");
    }
  });

  it('accepts `volume: true`', () => {
    const r = withTemplate('sizing-case', { ...base, services: { web: { ...web, volume: true } } }, () => run('lint.mjs'));
    expect(r.code, r.out).toBe(0);
  });
});

describe('lint: a self-built image must be tagged with its own version', () => {
  it('passes the registry as it stands', () => {
    expect(run('lint.mjs').code).toBe(0);
  });

  it('is scoped to images this repo builds', () => {
    // hermes references docker.io upstream in `upstream.image` and ghcr for its own; only the
    // second is subject to the rule, which is why the repo passes at all.
    const m = yaml.load(readFileSync(join(root, 'hermes/insta.template.yaml'), 'utf8'));
    expect(String(Object.values(m.services)[0].image)).toContain('ghcr.io/insforge/insta-oss/templates/hermes:');
    expect(String(Object.values(m.services)[0].image)).toContain(String(m.version));
  });
});
