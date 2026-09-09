#!/usr/bin/env python3
import io, sys

def sub(path, old, new, count=1):
    with io.open(path, encoding='utf-8') as f:
        txt = f.read()
    if new in txt:
        print('already applied'); return
    n = txt.count(old)
    if n != count:
        print('MISS: found %d of %d' % (n, count)); sys.exit(1)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(txt.replace(old, new, count))
    print('patched:', path)

p = 'COMPATIBILITY.md'

sub(p,
"| `policy` / `policy set` | implemented |\n",
"| policy get and set | implemented as routes (`GET /projects/:id/policy`, `PUT /projects/:id/policy/:action`) and in the dashboard. The CLI has no `policy` command of its own, on the cloud or here |\n")

sub(p,
"| `approvals list/approve/deny` (`--always`) | one-shot grants, same `202` flow |\n",
"| `approvals list/approve/deny` | one-shot grants, same `202` flow. `--always`, which flips the project policy to allow, is a field on the approve route (`{\"always\": true}`) and a control in the dashboard; the CLI does not expose a flag for it |\n")

sub(p,
"| `org_create · usage · billing_summary/checkout/portal · service_scale/upgrade · deploy_events` | `not_supported`, carrying the daemon `501` guidance verbatim |\n",
"| `org_create · usage · billing_summary/checkout/portal · service_scale/upgrade · deploy_events` | refused. The daemon answers `501` with its guidance, but insta-mcp maps every status at or above 500 to `platform_error` / `upstream error — retry`, so the sentence does not reach the agent and the refusal reads as transient. Ask the daemon directly, or the CLI, for the reason |\n")

print('done')
