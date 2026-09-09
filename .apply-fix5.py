#!/usr/bin/env python3
"""Storage rows read the object store's runtime from the S3 hostname, which is only a container
name in local mode."""
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

sub('src/engine.ts',
"        runtime: branch ? this.runtimeOf(this.s3Host(project, branch, s.id)?.split(':')[0] ?? '') : undefined,",
"        // The object store is ONE shared container for the whole box, so every bucket reports its\n"
"        // state. Not the S3 host: that is `io-garage` only in local mode, and in server mode it is\n"
"        // `s3.<domain>`, which matches no container, so every bucket on a real install read\n"
"        // 'stopped' while Garage was up and serving it.\n"
"        runtime: branch ? this.runtimeOf(GARAGE_CONTAINER) : undefined,")

print('done')
