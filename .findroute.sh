#!/bin/bash
grep -roh 'secrets/[a-zA-Z0-9/${}._:-]*' /usr/lib/node_modules/insta/dist 2>/dev/null | sort -u | head -20
echo '--- bindings ---'
grep -roh '[a-z-]*bindings[a-zA-Z0-9/${}._:-]*' /usr/lib/node_modules/insta/dist 2>/dev/null | sort -u | head -20
echo '--- sources ---'
grep -roh '[a-zA-Z0-9/${}._-]*sources[a-zA-Z0-9/${}._:-]*' /usr/lib/node_modules/insta/dist 2>/dev/null | sort -u | head -20
