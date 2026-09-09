import http.server, os, socketserver, json


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/env'):
            body = json.dumps({k: v for k, v in os.environ.items()}, indent=1).encode()
        else:
            body = json.dumps({"ok": True, "path": self.path, "host": os.uname().nodename}).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


port = int(os.environ.get('PORT', '8000'))
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('0.0.0.0', port), H) as httpd:
    httpd.serve_forever()
