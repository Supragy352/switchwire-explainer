"""Local preview server. Serves the site and wraps index.html in the same skeleton the
Artifact host adds at publish time (doctype, charset, viewport), so KaTeX and layout
behave the same locally. Usage: python -I tools/serve.py [port]
Static build (GitHub Pages): python -I tools/serve.py --build _site"""
import http.server, os, shutil, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
HEAD = (b'<!doctype html><html lang="en"><head><meta charset="utf-8">'
        b'<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
        b'<style>:root{padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}'
        b'body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
        b'</head><body>')


def page():
    return HEAD + open(os.path.join(ROOT, 'index.html'), 'rb').read() + b'</body></html>'


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_GET(self):
        if self.path.split('?')[0] in ('/', '/index.html'):
            body = page()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()


if sys.argv[1:2] == ['--build']:
    out = sys.argv[2]
    for d in ('js', 'models'):
        shutil.copytree(os.path.join(ROOT, d), os.path.join(out, d), dirs_exist_ok=True)
    open(os.path.join(out, 'index.html'), 'wb').write(page())
    sys.exit()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
