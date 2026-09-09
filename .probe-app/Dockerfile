FROM alpine:3.20
RUN apk add --no-cache python3 redis mysql-client mongodb-tools postgresql16-client curl bash aws-cli
COPY server.py /srv/server.py
EXPOSE 8000
CMD ["python3", "/srv/server.py"]
