"""Exercise side buttons in a real Herdr browser on a private X display.

Run an isolated Herdr first, then:
  DISPLAY=:156 HERDR_APP_HOME=... HC_SESSION=... uv run --with python-xlib \
    python tests/browser_navigation_live.py target/debug/herdr-app SPACE OUTPUT_DIR

Uses XTest input, a local HTTP fixture and page-side load acknowledgements.
Never point this test at the person's display or Herdr session.
"""
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

from Xlib import X, XK, display
from Xlib.ext import xtest

app, space, output, *extra = sys.argv[1:]
mod = next((arg for arg in extra if not arg.startswith("--")), "linear-browser")
probe = "--probe" in extra
output = Path(output)
output.mkdir(parents=True, exist_ok=True)
assert os.environ.get("HC_SESSION", "").startswith("lpt1560-"), "use a private test core"


class Fixture(http.server.BaseHTTPRequestHandler):
    page = None

    def log_message(self, format, *args):
        pass

    def do_POST(self):
        Fixture.page = self.path.removeprefix("/seen/")
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        page = self.path.strip("/") or "A"
        next_page = {"A": "B", "B": "C", "C": "A"}.get(page, "A")
        html = f"""<!doctype html><title>{page}</title>
<style>body {{ margin: 0; }} a {{ position: absolute; left: 20px; top: 80px; }}</style>
<h1>{page}</h1><a href='/{next_page}'>Next</a><p style='margin-top:150px'>Needle</p>
<script>addEventListener('pageshow', () => fetch('/seen/{page}', {{method:'POST'}}));</script>"""
        data = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{server.server_port}/A"


def command(*args):
    return json.loads(subprocess.check_output([app, "do", *args], text=True))


def wait_for(predicate, message, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError(f"{message}; last page={Fixture.page!r}")


def expect(page):
    wait_for(lambda: Fixture.page == page, f"expected page {page}")
    # A second accidental navigation may arrive after the first acknowledgement.
    time.sleep(0.35)
    assert Fixture.page == page, f"expected one step to {page}, got {Fixture.page}"
    print(json.dumps({"page": page}), flush=True)


d = display.Display()
root = d.screen().root


def find_host():
    return next((w for w in root.query_tree().children if w.get_wm_name() == "Herdr"), None)


def click(x, y, button=1):
    xtest.fake_input(d, X.MotionNotify, x=x, y=y)
    d.sync()
    time.sleep(0.15)
    xtest.fake_input(d, X.ButtonPress, button)
    xtest.fake_input(d, X.ButtonRelease, button)
    d.sync()


tab = command("tab.new", "--space", space, "--name", "Navigation regression", "--mod", mod, "--props", json.dumps({"url": url, "link": {"url": url}}))
try:
    expect("A")
    host = wait_for(find_host, "Herdr window not found")

    def surface():
        children = [w for w in host.query_tree().children if w.get_attributes().map_state == X.IsViewable]
        return max(children, key=lambda w: w.get_geometry().width * w.get_geometry().height) if children else None

    child = wait_for(surface, "native browser not found")
    origin = child.translate_coords(root, 0, 0)
    x, y = -origin.x, -origin.y
    size = child.get_geometry()
    click(x + 30, y + 90)
    expect("B")
    click(x + 30, y + 90)
    expect("C")
    for button, page in [(8, "B"), (8, "A"), (8, "A"), (9, "B"), (9, "C"), (9, "C"), (4, "C"), (5, "C"), (1, "C")]:
        click(x + size.width // 2, y + size.height // 2, button)
        expect(page)
    if probe:
        def key(symbol, mods=()):
            codes = [d.keysym_to_keycode(XK.string_to_keysym(m)) for m in mods]
            code = d.keysym_to_keycode(XK.string_to_keysym(symbol))
            for modifier in codes:
                xtest.fake_input(d, X.KeyPress, modifier)
            xtest.fake_input(d, X.KeyPress, code)
            xtest.fake_input(d, X.KeyRelease, code)
            for modifier in reversed(codes):
                xtest.fake_input(d, X.KeyRelease, modifier)
            d.sync()
            time.sleep(0.7)

        def capture(name):
            subprocess.run(["import", "-window", "root", str(output / f"{name}.png")], check=True)

        key("Left", ["Alt_L"])
        capture("alt-left")
        key("Right", ["Alt_L"])
        capture("alt-right")
        click(x + size.width // 2, y + size.height // 2, 3)
        capture("context-menu")
        key("Escape")
        key("f", ["Control_L"])
        capture("find")
        key("Escape")
        key("F12")
        capture("devtools")
    subprocess.run(["import", "-window", "root", str(output / "passed.png")], check=True)
    print("PASS: side buttons navigate exactly one history entry; boundaries and ordinary input stay put", flush=True)
except BaseException:
    subprocess.run(["import", "-window", "root", str(output / "failed.png")], check=False)
    raise
finally:
    command("tab.close", "--id", tab["tab"], "--confirmed", "true")
    server.shutdown()
    d.close()
