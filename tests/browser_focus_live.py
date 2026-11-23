"""Check Windows keyboard focus after leaving a native browser tab.

Run on an interactive test desktop with hc on PATH:
    py -3 tests/browser_focus_live.py path/to/herdr-app.exe

The test takes the foreground briefly and creates its own App home and core.
It sends no keyboard or pointer events to other apps.
"""
import ctypes as c
from ctypes import wintypes as w
import http.server
import json
import os
from pathlib import Path
import subprocess as sp
import sys
import tempfile
import threading
import time
import uuid


class Page(http.server.BaseHTTPRequestHandler):
    loaded = threading.Event()

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(b'<!doctype html><title>Focus fixture</title><input autofocus>')
        if self.path == '/focus':
            self.loaded.set()


def wait_for(predicate, description, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.1)
    raise AssertionError(description)


class Desktop:
    class GUIThreadInfo(c.Structure):
        _fields_ = [('size', w.DWORD), ('flags', w.DWORD)] + [
            (name, w.HWND) for name in ('active', 'focus', 'capture', 'menu', 'move', 'caret')
        ] + [('rect', w.RECT)]

    def __init__(self):
        user = c.WinDLL('user32', use_last_error=True)
        kernel = c.WinDLL('kernel32', use_last_error=True)
        self.callback = c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)

        def bind(dll, name, result, *args):
            fn = getattr(dll, name)
            fn.restype, fn.argtypes = result, args
            return fn

        self.enum = bind(user, 'EnumWindows', w.BOOL, self.callback, w.LPARAM)
        self.children = bind(user, 'EnumChildWindows', w.BOOL, w.HWND, self.callback, w.LPARAM)
        self.owner = bind(user, 'GetWindowThreadProcessId', w.DWORD, w.HWND, c.POINTER(w.DWORD))
        self.class_name = bind(user, 'GetClassNameW', c.c_int, w.HWND, w.LPWSTR, c.c_int)
        self.visible = bind(user, 'IsWindowVisible', w.BOOL, w.HWND)
        self.is_child = bind(user, 'IsChild', w.BOOL, w.HWND, w.HWND)
        self.foreground = bind(user, 'GetForegroundWindow', w.HWND)
        self.activate = bind(user, 'SetForegroundWindow', w.BOOL, w.HWND)
        self.set_focus = bind(user, 'SetFocus', w.HWND, w.HWND)
        self.attach = bind(user, 'AttachThreadInput', w.BOOL, w.DWORD, w.DWORD, w.BOOL)
        self.thread = bind(kernel, 'GetCurrentThreadId', w.DWORD)
        self.gui = bind(user, 'GetGUIThreadInfo', w.BOOL, w.DWORD, c.POINTER(self.GUIThreadInfo))

    def find(self, class_name, parent=None, pid=None):
        matches = []

        @self.callback
        def visit(hwnd, _):
            owner = w.DWORD()
            self.owner(hwnd, c.byref(owner))
            name = c.create_unicode_buffer(128)
            self.class_name(hwnd, name, len(name))
            if self.visible(hwnd) and name.value == class_name and (pid is None or owner.value == pid):
                matches.append(hwnd)
            return True

        if parent:
            self.children(parent, visit, 0)
        else:
            self.enum(visit, 0)
        return next(iter(matches), None)

    def focused(self, host):
        info = self.GUIThreadInfo(size=c.sizeof(self.GUIThreadInfo))
        if not self.gui(self.owner(host, None), c.byref(info)):
            raise c.WinError(c.get_last_error())
        return info.focus

    def focus_child(self, hwnd):
        own, target = self.thread(), self.owner(hwnd, None)
        if not self.attach(own, target, True):
            raise c.WinError(c.get_last_error())
        try:
            self.set_focus(hwnd)
        finally:
            self.attach(own, target, False)


def check(exe, root, page):
    home = root / 'home'
    home.mkdir()
    (home / 'shared.json').write_text(json.dumps({'layout': 'main', 'frame.welcomed': 'skipped'}))
    env = dict(os.environ, HERDR_APP_HOME=str(home), HC_SESSION=f'webview-{uuid.uuid4().hex[:12]}',
               XDG_CONFIG_HOME=str(root / 'config'), XDG_STATE_HOME=str(root / 'state'))
    for key in ('HC_SOCKET', 'HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_SCOPE'):
        env.pop(key, None)

    def cli(*args):
        result = sp.run(args, env=env, text=True, capture_output=True, timeout=15,
                        creationflags=sp.CREATE_NO_WINDOW)
        if result.returncode:
            raise sp.CalledProcessError(result.returncode, args, result.stdout, result.stderr)
        return result.stdout

    def do(command, **kwargs):
        return json.loads(cli(exe, 'do', command, json.dumps(kwargs)) or '{}')

    def ready():
        try:
            return json.loads(cli(exe, 'status'))
        except (sp.CalledProcessError, ValueError):
            return None

    desktop = Desktop()
    previous = desktop.foreground()
    cli('hc', 'server', 'start')
    app = None
    try:
        app = sp.Popen([exe], env=env, stdin=sp.DEVNULL)
        wait_for(ready, 'Herdr IPC did not start', 60)
        host = wait_for(lambda: desktop.find('Zed::Window', pid=app.pid), 'Herdr window did not open')
        if desktop.foreground() != host:
            desktop.activate(host)
        wait_for(lambda: desktop.foreground() == host, 'Herdr could not take foreground')
        terminal = do('space.new', name='Focus fixture', folder=str(root))
        for transition in ('close', 'switch'):
            Page.loaded.clear()
            def open_browser():
                try:
                    return do('app.open', mod='linear-browser', reuse='none', space=terminal['space'],
                              props={'url': page}, **{'for': terminal['terminal']})
                except sp.CalledProcessError as error:
                    # The space command can reply before the App sees the new live terminal.
                    if json.loads(error.stdout).get('error') == f'no terminal {json.dumps(terminal["terminal"])}':
                        return None
                    raise RuntimeError(error.stdout or error.stderr) from error

            browser = wait_for(open_browser, 'Herdr did not adopt the origin terminal')
            container = wait_for(lambda: desktop.find('WRY_WEBVIEW', parent=host), 'WebView2 did not open')
            if not Page.loaded.wait(10):
                raise AssertionError('The fixture page did not load')
            child = wait_for(lambda: desktop.find('Chrome_WidgetWin_0', parent=container), 'No WebView2 child')
            assert desktop.foreground() == host, 'The test window lost foreground before the transition'
            desktop.focus_child(child)
            wait_for(lambda: desktop.is_child(container, desktop.focused(host)), 'WebView2 did not take focus')
            if transition == 'close':
                do('tab.close', id=browser['tab'], confirmed=True)
            else:
                do('tab.select', id=terminal['tab'])
            wait_for(lambda: not desktop.visible(container), f'{transition}: WebView2 stayed visible')
            assert desktop.foreground() == host, f'{transition}: the test window lost foreground'
            wait_for(lambda: desktop.focused(host) == host, f'{transition}: keyboard focus did not return to Herdr', 2)
            assert json.loads(cli(exe, 'status'))['tab'] == terminal['tab']
            print(f'PASS: {transition} returned keyboard focus to Herdr', flush=True)
    finally:
        try:
            if app is not None and app.poll() is None:
                try:
                    do('app.quit')
                    app.wait(timeout=5)
                finally:
                    if app.poll() is None:
                        app.terminate()
                        app.wait(timeout=5)
        finally:
            if previous and not desktop.foreground():
                desktop.activate(previous)
            try:
                for terminal in json.loads(cli('hc', 'ls', '--json')).get('terminals', []):
                    cli('hc', 'kill', terminal['address'])
                    cli('hc', 'rm', terminal['address'])
            finally:
                cli('hc', 'server', 'stop')


if __name__ == '__main__':
    if os.name != 'nt' or len(sys.argv) != 2:
        sys.exit(__doc__)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Page)
    with server, tempfile.TemporaryDirectory(prefix='herdr-browser-focus-') as root:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            check(str(Path(sys.argv[1]).resolve(strict=True)), Path(root), f'http://127.0.0.1:{server.server_port}/focus')
        finally:
            server.shutdown()
