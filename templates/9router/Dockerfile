# Digest pins the exact image the volume fix was verified against; the 0.5.55 tag stays for readability.
FROM docker.io/decolua/9router:0.5.55@sha256:05d8d9ae4956b9cc32d76a7a012434609d81aca0576ac15a2b53beacccfd1282

# Chown the platform volume to the user upstream's entrypoint drops to, then hand over unchanged.
COPY --chmod=0755 entrypoint.sh /insta-entrypoint.sh
ENTRYPOINT ["/insta-entrypoint.sh"]
CMD ["node", "custom-server.js"]
