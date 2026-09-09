#!/usr/bin/env python3
"""The service settings page labels the plan cap as the machine's own size."""
import io, sys

def sub(path, old, new, count=1):
    with io.open(path, encoding='utf-8') as f:
        txt = f.read()
    if new in txt:
        print('already applied:', path); return
    n = txt.count(old)
    if n != count:
        print('MISS %s: found %d of %d' % (path, n, count)); sys.exit(1)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(txt.replace(old, new, count))
    print('patched:', path)

p = 'ui/src/pages/ServiceDetail.tsx'

# `cap` is the fixed grid ceiling the daemon accepts (8 vCPU, 8192 MB, 100 Gi), not this box.
sub(p,
"      {cap && <p className=\"mt-2 text-xs text-muted-foreground\">This machine: {cap.cpu} vCPU, {cap.memoryMb} MB</p>}",
"      {cap && <p className=\"mt-2 text-xs text-muted-foreground\">Ceiling: {cap.cpu} vCPU, {cap.memoryMb} MB. It is the grid the API accepts, not this box: a limit above what the box has is a limit the container never reaches.</p>}")

sub(p,
"      {cap && <p className=\"mt-1 text-xs text-muted-foreground\">This machine allows up to {cap} Gi.</p>}",
"      {cap && <p className=\"mt-1 text-xs text-muted-foreground\">Ceiling: {cap} Gi. Free space on the data volume is the real limit.</p>}")

print('done')
