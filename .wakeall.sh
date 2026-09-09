#!/bin/bash
# Wake every branch's postgres (and optionally app) from the laptop, timing each.
D=34-207-169-54.sslip.io
PW=l_caHQ4_QuIa1jIJuz0xtVMZFWauVHON
export PGCONNECT_TIMEOUT=90
for b in "$@"; do
  S=$(python3 -c 'import time;print(int(time.time()*1000))')
  R=$(psql "postgres://postgres:$PW@pg-db-scale-$b.$D:5432/app?sslmode=require" -Atc "select 1" 2>&1 | tail -1)
  E=$(python3 -c 'import time;print(int(time.time()*1000))')
  echo "pg $b $((E-S))ms -> $R"
done
