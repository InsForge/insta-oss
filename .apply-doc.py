#!/usr/bin/env python3
import io

path = 'COMPATIBILITY.md'
with io.open(path, encoding='utf-8') as f:
    txt = f.read()

anchor = "| `secrets set/unset NAME [--branch] [--service]` | project-wide, branch override, or service-bound; reserved names rejected (gated `secrets.write`) |\n"
row = "| `secrets bind` / `unbind` / `bindings` / `sources` | `501`: aliasing a credential onto an env name of your choosing is not built yet. Every service credential already reaches every compute container in the branch, under its suffixed name and, for the oldest service of each type, the unsuffixed one, so bind the value by reading that name or set your own with `secrets set` |\n"
assert txt.count(anchor) == 1, 'anchor'
if row not in txt:
    txt = txt.replace(anchor, anchor + row, 1)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(txt)
    print('patched', path)
else:
    print('already applied')
