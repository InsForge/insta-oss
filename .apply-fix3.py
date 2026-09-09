#!/usr/bin/env python3
"""compose.yml: write the resolved image and CA path in, so a plain `docker compose up -d` works."""
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

sub('install.sh',
"""# compose.yml: written by install.sh on every run; overrides go in compose.override.yml.
# The image and the CA file come from instad.env, which install.sh also symlinks to .env in this
# directory, so a plain \\`docker compose up -d\\` here interpolates them without --env-file. The
# data directory does NOT: it is written in here as the concrete path this run resolved, because
# compose interpolation lets the CALLING SHELL outrank --env-file, so an INSTA_OSS_DATA_DIR left
# over in an operator's environment would silently point every bind below (the daemon's own data,
# the certificate store, garage's meta and data) at another directory. This installer already
# refuses to move the data directory of an existing install, so the path is fixed at install time.""",
"""# compose.yml: written by install.sh on every run; overrides go in compose.override.yml.
# Nothing in here is interpolated: the image, the CA file and the data directory are written as the
# concrete values this run resolved. compose interpolation reads the CALLING SHELL and .env, never
# env_file, so \\`cd $CFG && docker compose up -d\\` (what the tuning docs tell you to run after
# editing instad.env) would otherwise render the image as \\`:\\` and drop NODE_EXTRA_CA_CERTS. The
# calling shell also OUTRANKS --env-file, so an INSTA_OSS_DATA_DIR or INSTA_OSS_IMAGE left over in
# an operator's environment would silently repoint every bind below (the daemon's own data, the
# certificate store, garage's meta and data) or name another image.""")

sub('install.sh',
"    image: \\${INSTA_OSS_IMAGE}:\\${INSTA_OSS_VERSION}",
"    image: $IMAGE:$VERSION")

sub('install.sh',
"""    environment:
      # set by install.sh with INSTA_OSS_TLS=internal so the daemon trusts the edge's own CA
      NODE_EXTRA_CA_CERTS: \\${INSTA_OSS_CA_FILE:-}""",
"""    environment:
      # set by install.sh with INSTA_OSS_TLS=internal so the daemon trusts the edge's own CA
      NODE_EXTRA_CA_CERTS: "$CA_FILE\"""")

print('done')
