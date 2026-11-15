import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codePrograms, roundsPast, vscodeLaunch, windowsFolder, withFile } from '../defaults/mods/vscode/launch.js';
import { forkGits, forkLaunch, forkPrograms, forkWorkspace, safeDirectory, windowsFolder as forkFolder } from '../defaults/mods/fork/launch.js';
import { editorVersion, localFolder, unityLaunch, unityRoots } from '../defaults/mods/unity/launch.js';

const windowsEnv = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ProgramFiles: 'C:\\Program Files', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' };
const env = (vars) => (name) => vars[name] ?? null;

test('folders become Windows paths', () => {
  for (const folder of [windowsFolder, forkFolder]) {
    assert.equal(folder('C:\\dev\\app'), 'C:\\dev\\app');
    assert.equal(folder('file:///C:/dev/my%20app'), 'C:\\dev\\my app');
    assert.equal(folder('file://server/share/app'), '\\\\server\\share\\app');
    assert.equal(folder('vscode-remote://wsl+Ubuntu/root/dev/c++'), '\\\\wsl.localhost\\Ubuntu\\root\\dev\\c++');
    assert.equal(folder('vscode-remote://wsl%2BUbuntu-24.04/root'), '\\\\wsl.localhost\\Ubuntu-24.04\\root');
    assert.throws(() => folder('vscode-remote://ssh-remote+vps/root/app'), /Only local and WSL/);
    assert.throws(() => folder('  '), /No folder/);
    assert.equal(folder('C:\\dev\\app\\'), 'C:\\dev\\app');
    assert.equal(folder('file:///C:/'), 'C:\\');
  }
});

test('VS Code comes from HERDR_VSCODE_EXE, then the user and machine installs', () => {
  assert.deepEqual(codePrograms(env({ ...windowsEnv, HERDR_VSCODE_EXE: 'D:\\code\\Code.exe' })), [
    'D:\\code\\Code.exe',
    'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
  ]);
  assert.deepEqual(codePrograms(env({})), []);
  assert.throws(() => vscodeLaunch('C:\\dev\\app', null, env({})), /VS Code is not installed/);
});

test('a new VS Code window opens its folder, by URI or path, titled by its name', () => {
  const wsl = vscodeLaunch('vscode-remote://wsl+Ubuntu/root/my%20app', null, env(windowsEnv));
  assert.deepEqual(wsl.description.args, ['--new-window', '--folder-uri', 'vscode-remote://wsl+Ubuntu/root/my%20app']);
  assert.equal(wsl.description.title, 'my app');
  assert.equal(wsl.description.class, 'Chrome_WidgetWin_1');
  assert.equal(wsl.later, null);
  const local = vscodeLaunch('C:\\dev\\app\\', null, env(windowsEnv));
  assert.deepEqual(local.description.args, ['--new-window', 'C:\\dev\\app\\']);
  assert.equal(local.description.title, 'app');
  assert.throws(() => vscodeLaunch(' ', null, env(windowsEnv)), /No folder/);
});

test('a new VS Code window gets its folder and file as paths', () => {
  const wsl = 'vscode-remote://wsl+Ubuntu/root/my%20app';
  assert.deepEqual(withFile(wsl, `${wsl}/src/a.rs:42:7`),
    { args: ['--new-window', '--remote', 'wsl+Ubuntu', '/root/my app', '/root/my app/src/a.rs'], later: `${wsl}/src/a.rs:42:7` });
  assert.deepEqual(withFile('vscode-remote://ssh-remote%2Bvps/srv', 'vscode-remote://ssh-remote%2Bvps/srv/a.rs'),
    { args: ['--new-window', '--remote', 'ssh-remote+vps', '/srv', '/srv/a.rs'], later: null });
  assert.deepEqual(withFile('file:///C:/dev/app', 'file:///C:/dev/app/a.rs:3'),
    { args: ['--new-window', 'C:\\dev\\app', 'C:\\dev\\app\\a.rs'], later: 'file:///C:/dev/app/a.rs:3' });
  assert.deepEqual(withFile('C:\\dev\\app', 'file:///C:/dev/app/a.rs')?.args, ['--new-window', 'C:\\dev\\app', 'C:\\dev\\app\\a.rs']);
  // A file on another machine, or a URI VS Code takes no path for, goes as a URI.
  assert.equal(withFile(wsl, 'file:///C:/dev/a.rs'), null);
  assert.equal(withFile('vscode-vfs://github/a/b', 'vscode-vfs://github/a/b/c.rs'), null);
  const launched = vscodeLaunch('vscode-vfs://github/a/b', 'vscode-vfs://github/a/b/c.rs', env(windowsEnv));
  assert.deepEqual(launched.description.args, ['--new-window', '--folder-uri', 'vscode-vfs://github/a/b', '--goto', '--file-uri', 'vscode-vfs://github/a/b/c.rs']);
});

test('files go to a new VS Code window again only in the rounds still ahead', () => {
  assert.equal(roundsPast(1000, 1000), 0);
  assert.equal(roundsPast(1000, 4000), 1);
  assert.equal(roundsPast(1000, 9000), 2);
  assert.equal(roundsPast(1000, 60000), 3);
});

test('Fork starts in a workspace of one repository', () => {
  const settings = {
    Theme: 1,
    Workspaces: {
      All: [
        { Name: 'Work', Repositories: ['C:\\work'], ActiveRepository: 'C:\\work' },
        { Name: 'Herdr', Repositories: ['C:\\old', 'C:\\other'], ActiveRepository: 'C:\\old', Color: 3 },
      ],
      ActiveWorkspace: 'Work',
      ShowInTitle: false,
    },
  };
  assert.deepEqual(forkWorkspace(settings, 'C:\\new'), {
    Theme: 1,
    Workspaces: {
      All: [
        { Name: 'Work', Repositories: ['C:\\work'], ActiveRepository: 'C:\\work' },
        { Name: 'Herdr', Repositories: ['C:\\new'], ActiveRepository: 'C:\\new', Color: 3 },
      ],
      ActiveWorkspace: 'Herdr',
      ShowInTitle: false,
    },
  });
  const wsl = '\\\\wsl.localhost\\Ubuntu\\root\\app';
  assert.deepEqual(forkWorkspace({ Theme: 1 }, wsl).Workspaces, {
    All: [{ Name: 'Herdr', Repositories: [wsl], ActiveRepository: wsl }],
    ActiveWorkspace: 'Herdr',
  });
  assert.throws(() => forkWorkspace([], 'C:\\new'), /not a JSON object/);
});

test('WSL repositories become safe directories', () => {
  assert.equal(safeDirectory('\\\\wsl.localhost\\Ubuntu\\root\\dev\\herdr-app'), '%(prefix)///wsl.localhost/Ubuntu/root/dev/herdr-app');
  assert.equal(safeDirectory('\\\\server\\share\\app'), '%(prefix)///server/share/app');
  assert.equal(safeDirectory('C:\\dev\\app'), null);
});

test("Fork's git is its chosen one, then its newest bundled one, then PATH's", () => {
  const dir = 'C:\\Users\\me\\AppData\\Local\\Fork';
  const bundled = [
    { name: '2.40', folder: true, modified: 1 },
    { name: '2.45', folder: true, modified: 5 },
    { name: 'notes.txt', folder: false, modified: 9 },
  ];
  assert.deepEqual(forkGits(dir, { GitInstancePath: 'D:\\git' }, bundled), [
    'D:\\git\\bin\\git.exe', 'D:\\git', `${dir}\\gitInstance\\2.45\\bin\\git.exe`, `${dir}\\gitInstance\\2.40\\bin\\git.exe`, 'git',
  ]);
  assert.deepEqual(forkGits(dir, null, null), ['git']);
});

test("Fork's launch is a process of the pane's own", () => {
  assert.deepEqual(forkPrograms(env(windowsEnv)), ['C:\\Users\\me\\AppData\\Local\\Fork\\current\\Fork.exe', 'C:\\Users\\me\\AppData\\Local\\Fork\\Fork.exe']);
  const launch = forkLaunch(env({ ...windowsEnv, HERDR_FORK_EXE: 'D:\\Fork.exe' }));
  assert.equal(launch.program[0], 'D:\\Fork.exe');
  assert.equal(launch.class, 'HwndWrapper[Fork.exe;*');
  assert.equal(launch.ownProcess, true);
  assert.throws(() => forkLaunch(env({})), /Fork is not installed/);
});

test('Unity projects name their editor version', () => {
  assert.equal(editorVersion('m_EditorVersion: 6000.6.6f1\nm_EditorVersionWithRevision: 6000.6.6f1 (d20c9ac777da)\n'), '6000.6.6f1');
  assert.equal(editorVersion('m_EditorVersion: 2022.3.62f3\r\n'), '2022.3.62f3');
  assert.equal(editorVersion('m_EditorVersion:   \n'), null);
  assert.equal(editorVersion(''), null);
});

test("Unity's editor comes from the Hub's chosen folder, then its default", () => {
  assert.deepEqual(unityRoots(env(windowsEnv), '\uFEFF"D:\\\\Unity"'), ['D:\\Unity', 'C:\\Program Files\\Unity\\Hub\\Editor']);
  assert.deepEqual(unityRoots(env(windowsEnv), '""'), ['C:\\Program Files\\Unity\\Hub\\Editor']);
  assert.deepEqual(unityRoots(env(windowsEnv), null), ['C:\\Program Files\\Unity\\Hub\\Editor']);
  const launch = unityLaunch('C:\\dev\\Game', '6000.6.6f1', ['D:\\Unity', 'C:\\Program Files\\Unity\\Hub\\Editor']);
  assert.deepEqual(launch.program, ['D:\\Unity\\6000.6.6f1\\Editor\\Unity.exe', 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.6.6f1\\Editor\\Unity.exe']);
  assert.deepEqual(launch.args, ['-projectPath', 'C:\\dev\\Game']);
  assert.equal(launch.title, 'Game');
  assert.equal(launch.once && launch.menuWindow && launch.ownProcess, true);
  assert.equal(launch.missing, 'Unity 6000.6.6f1 is not installed: install it with Unity Hub');
  assert.throws(() => unityLaunch('C:\\dev\\Game', '6000.6.6f1', []), /Unity 6000.6.6f1 is not installed/);
});

test('Unity opens projects on this computer', () => {
  assert.equal(localFolder('C:\\dev\\Game\\'), 'C:\\dev\\Game');
  assert.equal(localFolder('file:///C:/dev/My%20Game'), 'C:\\dev\\My Game');
  assert.equal(localFolder('file://server/share/Game'), '\\\\server\\share\\Game');
  assert.equal(localFolder('/root/Game'), null);
  assert.equal(localFolder(''), null);
});
