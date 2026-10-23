# Tiny local web server that tells the browser never to cache files,
# so changes show up right after a refresh. It always serves the folder this file is in.
#   python3 serve.py        (then open http://localhost:8000)
import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
handler = functools.partial(NoCacheHandler, directory=os.path.dirname(os.path.abspath(__file__)))
http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
