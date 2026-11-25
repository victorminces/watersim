"""Phone link: serve the app to a phone on the same Wi-Fi and talk to it.

The phone opens https://<this PC>:8443 (scan the QR code), accepts the
self-signed certificate once, and runs the app exactly as from GitHub Pages,
plus a small client (tools/phonelink.js) that reports back: console output,
errors, device and WebGL details, a heartbeat with fps, and screenshots of
the canvas on request. From this PC you can run JavaScript on the phone.

    python tools/phonelink.py serve          start the server, write the QR code
    python tools/phonelink.py status         connected pages and their last heartbeat
    python tools/phonelink.py log [-n 40]    recent console output and errors
    python tools/phonelink.py run "<js>"     evaluate on the phone, print the result
    python tools/phonelink.py snap [name]    screenshot of the canvas, prints the file
    python tools/phonelink.py reload         reload the page on the phone

Edits to the files show on the phone at the next reload (nothing is cached).
Logs, screenshots and the certificate live in a temp folder (--out), not in
the repo. Only this PC can send code to the phone: commands are accepted from
127.0.0.1 only.
"""

import argparse
import http.server
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import base64

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(tempfile.gettempdir(), 'watersim-phone')
PORT = 8443
CLIENT_TAG = b'<script src="/tools/phonelink.js"></script>'


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 53))  # picks the outbound interface; sends nothing
        return s.getsockname()[0]
    finally:
        s.close()


def find_openssl():
    for p in (shutil.which('openssl'),
              r'C:\Program Files\Git\mingw64\bin\openssl.exe',
              r'C:\Program Files\Git\usr\bin\openssl.exe'):
        if p and os.path.exists(p):
            return p
    sys.exit('openssl not found (it comes with Git for Windows)')


def ensure_cert(out, ip):
    cert, key, tag = (os.path.join(out, n) for n in ('cert.pem', 'key.pem', 'cert-ip.txt'))
    if os.path.exists(cert) and os.path.exists(key) and os.path.exists(tag):
        if open(tag).read().strip() == ip:
            return cert, key
    subprocess.run([find_openssl(), 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
                    '-days', '825', '-keyout', key, '-out', cert, '-subj', '/CN=watersim-phone',
                    '-addext', f'subjectAltName=IP:{ip},IP:127.0.0.1,DNS:localhost'],
                   check=True, capture_output=True)
    open(tag, 'w').write(ip)
    return cert, key


# ------------------------------------------------------------------ server state

class State:
    def __init__(self, out):
        self.out = out
        self.cond = threading.Condition()
        self.cmds = []          # {id, to, code}
        self.results = {}       # id -> entry
        self.clients = {}       # id -> {hello, seen, beat}
        self.next_id = 1
        self.snaps = 0
        self.log = open(os.path.join(out, 'log.jsonl'), 'a', encoding='utf-8')


def short(entry):
    d = entry.get('data')
    kind = entry.get('type')
    if kind == 'console':
        return f"{d.get('level')}: " + ' '.join(str(a) for a in d.get('args', []))
    if kind == 'result':
        return f"result #{d.get('id')}: " + json.dumps(d.get('value') if d.get('ok') else d.get('error'))[:300]
    return f'{kind}: ' + json.dumps(d)[:300]


class Handler(http.server.SimpleHTTPRequestHandler):
    state: State = None
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm'}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def local(self):
        return self.client_address[0] in ('127.0.0.1', '::1')

    def reply(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > 20_000_000:
            raise ValueError('too big')
        return self.rfile.read(n)

    # ---------------------------------------------------------------- GET

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(url.query)
        if url.path in ('/', '/index.html'):
            html = open(os.path.join(ROOT, 'index.html'), 'rb').read()
            html = html.replace(b'<head>', b'<head>\n' + CLIENT_TAG, 1)
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(html)))
            self.end_headers()
            self.wfile.write(html)
        elif url.path == '/__link/cmd':
            self.get_cmds(q.get('client', [''])[0], int(q.get('after', ['0'])[0]))
        elif url.path == '/__link/result' and self.local():
            self.get_result(int(q['id'][0]), float(q.get('timeout', ['30'])[0]))
        elif url.path == '/__link/clients' and self.local():
            with self.state.cond:
                self.reply(self.state.clients)
        else:
            super().do_GET()

    def get_cmds(self, client, after):
        st = self.state
        deadline = time.time() + 20
        with st.cond:
            if client in st.clients:
                st.clients[client]['seen'] = time.time()
            while True:
                mine = [c for c in st.cmds if c['id'] > after and c['to'] in (client, '*')]
                left = deadline - time.time()
                if mine or left <= 0:
                    break
                st.cond.wait(left)
        self.reply(mine)

    def get_result(self, cid, timeout):
        st = self.state
        deadline = time.time() + timeout
        with st.cond:
            while cid not in st.results and time.time() < deadline:
                st.cond.wait(deadline - time.time())
            res = st.results.get(cid)
        self.reply(res if res else {'timeout': True}, 200 if res else 504)

    # ---------------------------------------------------------------- POST

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(url.query)
        try:
            if url.path == '/__link/log':
                self.post_log(json.loads(self.body()))
            elif url.path == '/__link/snap':
                self.post_snap(q.get('client', ['?'])[0], q.get('name', ['snap'])[0], self.body())
            elif url.path == '/__link/cmd' and self.local():
                self.post_cmd(json.loads(self.body()))
            else:
                self.reply({'error': 'not here'}, 404)
        except Exception as e:  # a bad request should not take the server down
            self.reply({'error': repr(e)}, 400)

    def post_log(self, batch):
        st = self.state
        client = batch.get('client', '?')
        now = time.time()
        with st.cond:
            c = st.clients.setdefault(client, {'hello': None, 'seen': now, 'beat': None})
            c['seen'] = now
            for e in batch.get('entries', []):
                e['client'] = client
                kind = e.get('type')
                if kind == 'beat':
                    c['beat'] = e
                    continue
                if kind == 'hello':
                    c['hello'] = e
                if kind == 'result':
                    st.results[e['data']['id']] = e
                st.log.write(json.dumps(e) + '\n')
                print(f'[{client}] {short(e)}', flush=True)
            st.log.flush()
            st.cond.notify_all()
        self.reply({'ok': True})

    def post_snap(self, client, name, body):
        st = self.state
        data = body.decode()
        head, b64 = data.split(',', 1)
        ext = 'png' if 'png' in head else 'jpg'
        with st.cond:
            st.snaps += 1
            n = st.snaps
        safe = ''.join(ch for ch in name if ch.isalnum() or ch in '-_')[:40] or 'snap'
        path = os.path.join(st.out, f'snap-{n:03d}-{safe}.{ext}')
        with open(path, 'wb') as f:
            f.write(base64.b64decode(b64))
        self.reply({'path': path})

    def post_cmd(self, req):
        st = self.state
        with st.cond:
            to = req.get('to') or 'latest'
            if to == 'latest':
                live = [(c['hello']['t'], cid) for cid, c in st.clients.items()
                        if c['hello'] and time.time() - c['seen'] < 30]
                if not live:
                    self.reply({'error': 'no page connected'}, 409)
                    return
                to = max(live)[1]
            cmd = {'id': st.next_id, 'to': to, 'code': req['code']}
            st.next_id += 1
            st.cmds.append(cmd)
            st.cond.notify_all()
        self.reply(cmd)


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    seen = set()

    def verify_request(self, request, client_address):
        # Say when a new device first knocks, so "it won't load" can be told
        # apart from "it never got here" (Wi-Fi that keeps devices apart).
        ip = client_address[0]
        if ip not in self.seen and ip not in ('127.0.0.1', '::1'):
            self.seen.add(ip)
            print(f'connection from {ip}', flush=True)
        return True

    def handle_error(self, request, client_address):
        err = sys.exc_info()[1]
        if isinstance(err, ssl.SSLError):
            print(f'{client_address[0]} refused the certificate ({err.reason}): tap Advanced, then Proceed', flush=True)
            return
        if isinstance(err, (ConnectionError, TimeoutError, OSError)):
            return
        super().handle_error(request, client_address)


def serve(args):
    os.makedirs(args.out, exist_ok=True)
    ip = args.host or lan_ip()
    cert, key = ensure_cert(args.out, ip)
    Handler.state = State(args.out)
    httpd = Server(('0.0.0.0', args.port), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    # Handshake in the request thread, so one stalled phone connection cannot block accept().
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True, do_handshake_on_connect=False)
    # The same thing over plain http on this PC only: for a desktop browser, or a
    # phone on a USB cable with Chrome's port forwarding (chrome://inspect), where
    # http://localhost counts as secure and no certificate is needed.
    plain = Server(('127.0.0.1', args.port + 1), Handler)
    threading.Thread(target=plain.serve_forever, daemon=True).start()
    url = f'https://{ip}:{args.port}/'
    qr = write_qr(url, args.out)
    print(f'phone link at {url}  (and http://localhost:{args.port + 1}/ on this PC)\n'
          f'QR code: {qr}\nlogs: {args.out}', flush=True)
    httpd.serve_forever()


def write_qr(url, out):
    path = os.path.join(out, 'qr.png')
    try:
        import segno
        segno.make(url, error='m').save(path, scale=12, border=3)
    except ImportError:
        path = '(pip install segno for a QR image)'
    return path


# ------------------------------------------------------------------ commands from this PC

def call(args, method, path, payload=None, timeout=40):
    ctx = ssl.create_default_context(cafile=os.path.join(args.out, 'cert.pem'))
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(f'https://127.0.0.1:{args.port}{path}', data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b'{}') | {'http': e.code}


def run_js(args, code, timeout):
    cmd = call(args, 'POST', '/__link/cmd', {'code': code, 'to': args.to})
    if 'error' in cmd:
        sys.exit(cmd['error'])
    res = call(args, 'GET', f"/__link/result?id={cmd['id']}&timeout={timeout}", timeout=timeout + 10)
    if res.get('timeout'):
        sys.exit(f"no answer from {cmd['to']} within {timeout}s")
    return res['data']


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--out', default=OUT)
    p.add_argument('--port', type=int, default=PORT)
    p.add_argument('--to', default='latest', help='page id to talk to (default: the newest)')
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('serve')
    s.add_argument('--host', help='address to put in the QR code (default: this PC on the LAN)')
    sub.add_parser('status')
    lg = sub.add_parser('log')
    lg.add_argument('-n', type=int, default=40)
    r = sub.add_parser('run')
    r.add_argument('code')
    r.add_argument('--timeout', type=float, default=30)
    sn = sub.add_parser('snap')
    sn.add_argument('name', nargs='?', default='snap')
    sub.add_parser('reload')
    args = p.parse_args()

    if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
        sys.stdout.reconfigure(encoding='utf-8')

    if args.cmd == 'serve':
        serve(args)
    elif args.cmd == 'status':
        clients = call(args, 'GET', '/__link/clients')
        now = time.time()
        for cid, c in sorted(clients.items(), key=lambda kv: kv[1]['seen']):
            hello = (c['hello'] or {}).get('data', {})
            beat = (c['beat'] or {}).get('data', {})
            print(f"{cid}  seen {now - c['seen']:.0f}s ago  {hello.get('ua', '?')[:90]}")
            if beat:
                print('   ', json.dumps(beat))
    elif args.cmd == 'log':
        path = os.path.join(args.out, 'log.jsonl')
        lines = open(path, encoding='utf-8').read().splitlines()[-args.n:] if os.path.exists(path) else []
        for line in lines:
            e = json.loads(line)
            print(time.strftime('%H:%M:%S', time.localtime(e['t'] / 1000)), f"[{e['client']}]", short(e))
    elif args.cmd == 'run':
        res = run_js(args, args.code, args.timeout)
        print(json.dumps(res.get('value'), indent=1) if res.get('ok') else 'ERROR ' + str(res.get('error')))
        sys.exit(0 if res.get('ok') else 1)
    elif args.cmd == 'snap':
        res = run_js(args, f'return await snap({json.dumps(args.name)})', 30)
        print(res.get('value') if res.get('ok') else 'ERROR ' + str(res.get('error')))
    elif args.cmd == 'reload':
        cmd = call(args, 'POST', '/__link/cmd', {'code': 'setTimeout(() => location.reload(), 50); return "reloading"', 'to': args.to})
        print(cmd)


if __name__ == '__main__':
    main()
