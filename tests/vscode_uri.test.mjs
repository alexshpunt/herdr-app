import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appTarget, editorUri, outsideFolder, parentFolder, place } from '../defaults/mods/vscode/uri.js';

const machines = [
  { name: 'ubuntu', target: 'zinlaptop-wsl', editorAuthority: 'wsl+Ubuntu' },
  { name: 'vps', target: 'pi-vps' },
];

test('local folders become file URIs', () => {
  assert.equal(editorUri('C:\\Users\\me\\my app', null, machines), 'file:///C:/Users/me/my%20app');
  assert.equal(editorUri('\\\\wsl.localhost\\Ubuntu\\root\\app', null, machines), 'file://wsl.localhost/Ubuntu/root/app');
  assert.throws(() => editorUri('/root/app', null, machines), /local Windows path/);
});

test('WSL folders open in WSL, and Windows drives as local folders', () => {
  assert.equal(editorUri('/root/dev/c++', 'ubuntu', machines), 'vscode-remote://wsl+Ubuntu/root/dev/c%2B%2B');
  assert.equal(editorUri('/mnt/c/Users/me', 'ubuntu', machines), 'file:///C:/Users/me');
});

test('SSH folders open over SSH', () => {
  assert.equal(editorUri('/root/app', 'vps', machines), 'vscode-remote://ssh-remote+pi-vps/root/app');
  assert.throws(() => editorUri('/root/app', 'away', machines), /no route to away/);
});

test('a file link puts VS Code at its line and column', () => {
  assert.equal(place({ line: 42, column: 7 }), ':42:7');
  assert.equal(place({ line: 42, column: null }), ':42');
  assert.equal(place({}), '');
});

test('a file is in its folder', () => {
  assert.equal(parentFolder('/root/app/src/main.rs'), '/root/app/src');
  assert.equal(parentFolder('C:\\notes.txt'), 'C:\\');
  assert.equal(parentFolder('/notes.txt'), '/');
});

test('an app opens the pane\'s project, a linked folder, or a linked file in its project', () => {
  const project = { folder: '/root/app', machine: 'ubuntu' };
  assert.deepEqual(appTarget({ project }, machines), { folder: 'vscode-remote://wsl+Ubuntu/root/app', goto: null });
  assert.deepEqual(appTarget({ project, link: { kind: 'folder', path: '/root/other', machine: 'ubuntu' } }, machines),
    { folder: 'vscode-remote://wsl+Ubuntu/root/other', goto: null });
  const inProject = { kind: 'file', path: '/root/app/src/a.rs', machine: 'ubuntu', line: 4 };
  assert.equal(outsideFolder({ project, link: inProject }), null);
  assert.deepEqual(appTarget({ project, link: inProject }, machines),
    { folder: 'vscode-remote://wsl+Ubuntu/root/app', goto: 'vscode-remote://wsl+Ubuntu/root/app/src/a.rs:4' });
  // A file elsewhere: its own folder, unless its Git work tree is passed as the project.
  const elsewhere = { kind: 'file', path: '/root/lib/src/b.rs', machine: 'ubuntu' };
  assert.equal(outsideFolder({ project, link: elsewhere }), '/root/lib/src');
  assert.equal(appTarget({ project, link: elsewhere }, machines).folder, 'vscode-remote://wsl+Ubuntu/root/lib/src');
  assert.equal(appTarget({ project: { folder: '/root/lib', machine: 'ubuntu' }, link: elsewhere }, machines).folder, 'vscode-remote://wsl+Ubuntu/root/lib');
  // The same path on another machine is another project.
  assert.equal(outsideFolder({ project, link: { ...inProject, machine: null } }), '/root/app/src');
  assert.throws(() => appTarget({}, machines), /No project folder/);
});
