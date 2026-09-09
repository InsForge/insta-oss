#!/bin/bash
now() { python3 -c 'import time;print(int(time.time()*1000))'; }
IP=34.207.169.54
D=34-207-169-54.sslip.io
RH=redis-cache-gov2-main.$D
MH=mongodb-docs-gov2-main.$D

S=$(now)
R=$(redis-cli --tls --sni "$RH" -h $IP -p 6379 -a 8gMNNZqZPba7TniueGRQn6GFFV2Kk2-o3wHLxvsk63c --user default GET probe 2>&1 | tail -1)
E=$(now)
echo "redis wake $((E-S))ms -> $R"

S=$(now)
M=$(mysql -h $IP -P 20000 -u insta -p0NVF_T2YCPeQmkb7UwSDniYchKl7QRnba1AihEr5IG0 -D app -e "select 1 as ok" 2>&1 | tail -1)
E=$(now)
echo "mysql wake $((E-S))ms -> $M"

S=$(now)
G=$(echo Q | openssl s_client -connect $IP:27017 -servername "$MH" 2>/dev/null | openssl x509 -noout -subject 2>/dev/null)
E=$(now)
echo "mongo tls $((E-S))ms -> $G"
