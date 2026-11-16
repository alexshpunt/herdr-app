"""Research-only X11 reparenting experiment. Not a Herdr NativeApp backend.

On a private Xvfb display, run with python-xlib and websocket-client:
  HERDR_RESEARCH_DISPLAY=:156 DISPLAY=:156 uv run --with python-xlib \
    --with websocket-client python tests/fixtures/browser_hosting_linux.py \
    CHROME URL OUTPUT_DIR
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request

from Xlib import X, XK, display
from Xlib.ext import xtest
import websocket

chrome, url, output_arg = sys.argv[1:]
output = Path(output_arg)
output.mkdir(parents=True, exist_ok=True)
assert os.environ.get("HERDR_RESEARCH_DISPLAY") == os.environ.get("DISPLAY")
assert os.environ.get("DISPLAY"), "use a private X display"
d = display.Display()
root = d.screen().root
host = root.create_window(150, 100, 1000, 700, 0, d.screen().root_depth, X.InputOutput, X.CopyFromParent, background_pixel=d.screen().white_pixel)
host.set_wm_name("Herdr Chrome research host")
host.map()
d.sync()
profile = tempfile.TemporaryDirectory(prefix="herdr-chrome-research-")
process = subprocess.Popen([chrome, f"--user-data-dir={profile.name}", "--ozone-platform=x11", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=9460", "--window-size=1000,700", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
ws = None
serial = 0


def wait_for(fn, label):
    until = time.monotonic() + 20
    while time.monotonic() < until:
        try:
            result = fn()
            if result:
                return result
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    raise AssertionError(label)


def target():
    with urllib.request.urlopen("http://127.0.0.1:9460/json/list", timeout=1) as response:
        return next((p for p in json.load(response) if p.get("type") == "page" and p.get("url") == url), None)


def call(method, params=None):
    global serial
    assert ws is not None, "debugging connection not established"
    serial += 1
    ws.send(json.dumps({"id": serial, "method": method, "params": params or {}}))
    while True:
        answer = json.loads(ws.recv())
        if answer.get("id") == serial:
            assert "error" not in answer, answer
            return answer.get("result", {})


def evaluate(expression):
    result = call("Runtime.evaluate", {"expression": expression, "returnByValue": True})
    assert "exceptionDetails" not in result, result
    return result["result"].get("value")


def chrome_window():
    atom = d.intern_atom("_NET_WM_PID")
    for child in root.query_tree().children:
        pid = child.get_full_property(atom, X.AnyPropertyType)
        if pid is not None and int(pid.value[0]) == process.pid and child.get_geometry().width > 400:
            return child
    return None


def key(symbol, mods=()):
    held = [d.keysym_to_keycode(XK.string_to_keysym(m)) for m in mods]
    code = d.keysym_to_keycode(XK.string_to_keysym(symbol))
    for mod in held:
        xtest.fake_input(d, X.KeyPress, mod)
    xtest.fake_input(d, X.KeyPress, code)
    xtest.fake_input(d, X.KeyRelease, code)
    for mod in reversed(held):
        xtest.fake_input(d, X.KeyRelease, mod)
    d.sync()
    time.sleep(0.2)


def click(x, y, button=1):
    pos = host.translate_coords(root, 0, 0)
    xtest.fake_input(d, X.MotionNotify, x=-pos.x + int(x), y=-pos.y + int(y))
    d.sync()
    time.sleep(0.15)
    xtest.fake_input(d, X.ButtonPress, button)
    xtest.fake_input(d, X.ButtonRelease, button)
    d.sync()
    time.sleep(0.3)


def shot(name):
    subprocess.run(["import", "-window", "root", str(output / f"{name}.png")], check=True)


try:
    page = wait_for(target, "Chrome debugging page not found")
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=5, suppress_origin=True)
    child = wait_for(chrome_window, "Chrome X11 window not found")
    child.reparent(host, 0, 0)
    child.configure(x=0, y=0, width=1000, height=700)
    child.map()
    d.sync()
    time.sleep(1)
    assert child.query_tree().parent.id == host.id
    shot("embedded")
    host.configure(width=850, height=600)
    child.configure(width=850, height=600)
    d.sync()
    time.sleep(0.5)
    geometry = child.get_geometry()
    assert (geometry.width, geometry.height) == (850, 600)
    toolbar = evaluate("outerHeight-innerHeight")
    field = evaluate("(() => { const r=document.querySelector('input').getBoundingClientRect(); return {x:r.x+20,y:r.y+8}; })()")
    child.set_input_focus(X.RevertToParent, X.CurrentTime)
    click(field["x"], toolbar + field["y"])
    key("a")
    key("b")
    assert evaluate("document.querySelector('input').value") == "ab", "native keyboard focus failed"
    key("f", ["Control_L"])
    shot("find")
    key("Escape")
    click(500, 350, 3)
    shot("context-menu")
    key("Escape")
    # A host-owned overlay can be stacked above the foreign child on X11.
    overlay = host.create_window(400, 200, 300, 120, 0, d.screen().root_depth, X.InputOutput, X.CopyFromParent, background_pixel=0x335588)
    overlay.map()
    overlay.configure(stack_mode=X.Above)
    d.sync()
    shot("overlay")
    overlay.destroy()
    d.sync()
    print(json.dumps({"embedded": True, "resized": [geometry.width, geometry.height], "nativeKeyboardInput": "ab", "profile": "isolated", "display": os.environ["DISPLAY"], "scope": "standalone X11 host, not a Herdr Linux NativeApp implementation"}), flush=True)
finally:
    if ws:
        try:
            call("Browser.close")
        except (OSError, websocket.WebSocketException):
            pass
        ws.close()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.terminate()
        process.wait(timeout=5)
    host.destroy()
    d.close()
    profile.cleanup()
