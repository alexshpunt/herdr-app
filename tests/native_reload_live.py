"""Windows live regression. Run in the interactive desktop session on ZinPC.

Uses a new App home and core session. The supplied executable is copied out of
its build folder. --keep leaves the test window open for visual inspection.
"""
import argparse
import ctypes as c
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import shutil
import subprocess as sp
import time


def wait_for(check, seconds=40):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        value = check()
        if value:
            return value
        time.sleep(0.2)
    raise AssertionError(f"condition did not settle within {seconds}s")


def main():
    if os.name != 'nt':
        raise RuntimeError('Run this test on Windows in the interactive desktop session')
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--exe', required=True, type=Path)
    parser.add_argument('--home', required=True, type=Path)
    parser.add_argument('--unity-version', default='6000.6.6f1')
    parser.add_argument('--keep', action='store_true')
    parser.add_argument('--without-unity', action='store_true', help='Check Fork and Code when Unity activation is unavailable')
    args = parser.parse_args()
    root = args.home.resolve()
    assert not root.exists(), f"test directory already exists: {root}"
    root.mkdir(parents=True)
    home = root / 'home'
    home.mkdir()
    exe = root / 'herdr-app.exe'
    shutil.copy2(args.exe, exe)
    env = os.environ.copy()
    env.update(HERDR_APP_HOME=str(home), HC_SESSION=f'lpt1519-{os.getpid()}',
               HERDR_FORK_EXE=str(Path(env['LOCALAPPDATA']) / 'Fork/current/Fork.exe'),
               HERDR_VSCODE_EXE=str(Path(env['LOCALAPPDATA']) / 'Programs/Microsoft VS Code/Code.exe'))
    local = root / 'local'
    (local / 'Fork').mkdir(parents=True)
    settings = Path(env['LOCALAPPDATA']) / 'Fork/settings.json'
    if settings.exists():
        shutil.copy2(settings, local / 'Fork/settings.json')
    env['LOCALAPPDATA'] = str(local)
    (root / 'environment.json').write_text(json.dumps({k: env[k] for k in ('HERDR_APP_HOME', 'HC_SESSION', 'LOCALAPPDATA')}, indent=2))
    log = (root / 'app.log').open('w', encoding='utf-8')
    process = sp.Popen([str(exe)], env=env, stdout=log, stderr=log)

    def cli(*parts):
        result = sp.run([str(exe), *parts], env=env, capture_output=True, text=True, timeout=20)
        if result.returncode:
            raise RuntimeError(f"{parts}: {result.stdout} {result.stderr}")
        if parts[0] == 'shot':
            assert Path(parts[1]).is_file()
            return result.stdout.strip()
        return json.loads(result.stdout)

    def do(command, **fields):
        result = cli('do', command, json.dumps(fields))
        print(json.dumps({'command': command, 'result': result}), flush=True)
        return result

    def ready():
        try:
            return cli('status')
        except (RuntimeError, ValueError):
            return None

    u = c.WinDLL('user32', use_last_error=True)
    callback = c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    u.EnumWindows.argtypes = [callback, w.LPARAM]
    u.EnumChildWindows.argtypes = [w.HWND, callback, w.LPARAM]
    u.GetWindowThreadProcessId.argtypes = [w.HWND, c.POINTER(w.DWORD)]
    u.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, c.c_int]
    u.GetWindowTextW.argtypes = [w.HWND, w.LPWSTR, c.c_int]
    u.GetWindow.argtypes = [w.HWND, w.UINT]
    u.GetWindow.restype = w.HWND
    u.GetParent.argtypes = [w.HWND]
    u.GetParent.restype = w.HWND

    def pid(hwnd):
        value = w.DWORD()
        u.GetWindowThreadProcessId(hwnd, c.byref(value))
        return value.value

    def text(hwnd, class_name=False):
        value = c.create_unicode_buffer(1024)
        (u.GetClassNameW if class_name else u.GetWindowTextW)(hwnd, value, len(value))
        return value.value

    def windows(parent=None):
        found = []
        @callback
        def visit(hwnd, _):
            found.append(hwnd)
            return True
        if parent is None:
            u.EnumWindows(visit, 0)
        else:
            u.EnumChildWindows(parent, visit, 0)
        return found

    def native():
        hosts = [h for h in windows() if pid(h) == process.pid]
        result = []
        for host in hosts:
            for container in windows(host):
                if text(container, True) != 'HerdrNativeAppHost':
                    continue
                child = u.GetWindow(container, 5)  # GW_CHILD
                if child:
                    result.append(dict(host=host, container=container, child=child,
                                       pid=pid(child), cls=text(child, True), title=text(child)))
        return sorted(result, key=lambda r: r['child'])

    tabs = []
    space = None
    try:
        wait_for(ready)
        do('overlay.close')
        space = do('space.new', name='LPT-1519 reload', folder=str(root))['space']
        # Only the test copy of Code's launch gets a private user-data folder.
        launch = home / 'mods/vscode/launch.js'
        code = launch.read_text(encoding='utf-8')
        code = code.replace('program, args, class:',
                            f'program, args: ["--user-data-dir", {json.dumps(str(root / "code-data"))}, "--disable-extensions", ...args], class:')
        launch.write_text(code, encoding='utf-8')
        code_settings = root / 'code-data/User/settings.json'
        code_settings.parent.mkdir(parents=True)
        code_settings.write_text(json.dumps({'security.workspace.trust.enabled': False,
                                            'workbench.startupEditor': 'none', 'update.mode': 'none'}))
        for index in range(3):
            repo = root / f'repo-{index}'
            repo.mkdir()
            sp.run(['git', 'init', '-q', str(repo)], check=True)
            if index == 0:
                result = do('tab.new', name='Fork 0', mod='fork', props={'folder': str(repo)})
            else:
                result = do('app.open', mod='fork', title=f'Diff {index}', reuse='none', props={'folder': str(repo), 'project': None})
            tabs.append(result['tab'])
            wait_for(lambda: len(native()) == index + 1)
        code_folder = root / 'code-project'
        code_folder.mkdir()
        tabs.append(do('tab.new', name='Code', mod='vscode', props={'folder': str(code_folder)})['tab'])
        wait_for(lambda: len(native()) == 4)
        if not args.without_unity:
            project = root / 'UnityReload'
            for part in ('Assets', 'ProjectSettings', 'Packages'):
                (project / part).mkdir(parents=True)
            (project / 'ProjectSettings/ProjectVersion.txt').write_text(f'm_EditorVersion: {args.unity_version}\n')
            (project / 'Packages/manifest.json').write_text('{"dependencies": {}}')
            tabs.append(do('tab.new', name='Unity', mod='unity', props={'folder': str(project)})['tab'])
            wait_for(lambda: len(native()) == 5, 240)
        mods = ('fork', 'vscode') if args.without_unity else ('fork', 'vscode', 'unity')
        before = native()
        (root / 'before.json').write_text(json.dumps(before, indent=2))
        cli('shot', str(root / 'before.png'))
        # Each save restarts all copies of that mod, including hidden Diff apps.
        # Editing a shipped file in this private home follows the user's path.
        for round_number in range(2):
            for mod in mods:
                path = home / f'mods/{mod}/main.js'
                path.write_text(path.read_text(encoding='utf-8') + f'\n// live reload {round_number}\n', encoding='utf-8')
                time.sleep(5)  # Beyond both the 2 s orphan grace and 4 s lease.
                after = native()
                assert [(r['child'], r['pid'], r['container']) for r in after] == [
                    (r['child'], r['pid'], r['container']) for r in before], (mod, before, after)
                for tab in tabs:
                    do('tab.select', id=tab)
                    assert not cli('status')['errors']
                (root / f'after-{round_number}-{mod}.json').write_text(json.dumps(after, indent=2))
        # A rejected candidate must leave the working copies' windows alone.
        path = home / 'mods/fork/main.js'
        good = path.read_text(encoding='utf-8')
        path.write_text('''import { View } from "gpui-kit";
import { NativeAppState } from "herdr-browser";
import { props } from "herdr";
export default class extends View {
  init() { this.app = NativeAppState(`fork\\n${props().folder}`); throw new Error("rollback fixture"); }
  render() { return null; }
}
''', encoding='utf-8')
        time.sleep(5)
        assert [(r['child'], r['pid'], r['container']) for r in native()] == [
            (r['child'], r['pid'], r['container']) for r in before]
        assert cli('status')['errors']
        path.write_text(good, encoding='utf-8')
        time.sleep(5)
        assert [(r['child'], r['pid'], r['container']) for r in native()] == [
            (r['child'], r['pid'], r['container']) for r in before]
        for index, tab in enumerate(tabs):
            do('tab.select', id=tab)
            time.sleep(0.5)
            cli('shot', str(root / f'after-tab-{index}.png'))
        (root / 'result.json').write_text(json.dumps({'passed': True, 'mods': mods, 'app_pid': process.pid, 'tabs': tabs, 'native': native()}, indent=2))
        print(json.dumps({'passed': True, 'evidence': str(root), 'pid': process.pid}), flush=True)
    finally:
        if not args.keep:
            if space is not None:
                do('space.close', id=space, confirmed=True)
            do('app.quit')
            process.wait(timeout=20)
        log.close()


if __name__ == '__main__':
    main()
