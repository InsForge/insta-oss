#!/usr/bin/env python3
"""secret-binding routes: answer 501 with the local workaround instead of a bare 404."""
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

sub('src/server.ts',
"""  // Not-yet surfaces (real local answers exist meanwhile):
  app.get('/projects/:id/deploy-events', async (_req, reply) => notYet(reply, 'the deploy-event feed', 'use `insta events` and `insta logs`'))
""",
"""  // Not-yet surfaces (real local answers exist meanwhile):
  app.get('/projects/:id/deploy-events', async (_req, reply) => notYet(reply, 'the deploy-event feed', 'use `insta events` and `insta logs`'))
  // Aliasing one credential onto an env name of your choosing. The credentials themselves are
  // already in every compute container, under their own names and, for the oldest service of each
  // type, the unsuffixed ones as well, so the local answer is to read those. `insta secrets bind`,
  // `unbind`, `bindings` and `sources` all land here, and a bare 404 would read as a broken CLI.
  const noBindings = 'read the credential straight from the container environment (`insta secrets list` names them) or set your own name with `insta secrets set`'
  app.get('/projects/:id/secret-bindings', async (_req, reply) => notYet(reply, 'service credential bindings', noBindings))
  app.put('/projects/:id/secret-bindings/:envName', async (_req, reply) => notYet(reply, 'service credential bindings', noBindings))
  app.delete('/projects/:id/secret-bindings/:envName', async (_req, reply) => notYet(reply, 'service credential bindings', noBindings))
""")
print('done')
