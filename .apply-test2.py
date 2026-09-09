#!/usr/bin/env python3
import io, sys

path = 'test/server.test.ts'
with io.open(path, encoding='utf-8') as f:
    txt = f.read()

old = """  const notYetRoutes: Array<[string, string]> = [
    ['GET', '/projects/x/deploy-events'],
  ]"""
new = """  const notYetRoutes: Array<[string, string]> = [
    ['GET', '/projects/x/deploy-events'],
    // `insta secrets bind` / `unbind` / `bindings` / `sources` all reach these three.
    ['GET', '/projects/x/secret-bindings'],
    ['PUT', '/projects/x/secret-bindings/MY_VAR'],
    ['DELETE', '/projects/x/secret-bindings/MY_VAR'],
  ]"""
if new in txt:
    print('already applied')
else:
    assert txt.count(old) == 1, 'anchor'
    txt = txt.replace(old, new, 1)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(txt)
    print('patched', path)
