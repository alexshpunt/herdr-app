import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir, release } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const wsl = process.platform === 'linux' && /microsoft/i.test(release());
// Keep imports native; Pi's TypeScript loader otherwise caches dependencies on /reload.
export function importFresh(url) { return import(url); }
export async function runJson(command, args, options = {}) {
  const { stdout } = await execute(command, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...options });
  let value;
  try { value = JSON.parse(stdout); }
  catch { throw new Error(`${path.basename(command)} returned a non-JSON result; inspect the running app before retrying a mutation`); }
  if (value?.error) throw new Error(typeof value.error === 'string' ? value.error : JSON.stringify(value.error));
  return value;
}
export async function resolveApp() {
  if (process.env.HERDR_APP_BIN) return process.env.HERDR_APP_BIN;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Programs', 'herdr-app', 'herdr-app.exe');
  if (wsl) {
    const absolute = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
    const powershell = process.env.HERDR_WINDOWS_POWERSHELL || await access(absolute).then(() => absolute, () => 'powershell.exe');
    const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetFolderPath("LocalApplicationData")'], { timeout: 10000, windowsHide: true });
    return (await execute('wslpath', ['-u', path.win32.join(stdout.trim(), 'Programs', 'herdr-app', 'herdr-app.exe')], { timeout: 5000 })).stdout.trim();
  }
  return 'herdr-app';
}

export class AppClient {
  constructor(bindOrigin, pid, session) { this.bindOrigin = bindOrigin; this.pid = pid; this.session = session; }
  async app(args, options) { return runJson(await resolveApp(), args, options); }
  async command(name, args = {}) {
    const launch = ['space.new', 'tab.new', 'pane.split', 'terminal.open'].includes(name);
    return this.app(['do', name, JSON.stringify(args)], { timeout: launch ? 100000 : name.startsWith('agent.') ? 35000 : 15000 });
  }
  async owner() {
    if (!process.env.HC_TERMINAL_ID || !process.env.HC_TERMINAL_SOCKET) throw new Error('Run this Pi in a Herdr App terminal; HC terminal identity is missing');
    const terminal = await runJson(process.env.HC_BIN || 'hc', ['get', process.env.HC_TERMINAL_ID, '--json']);
    if (terminal.foreground?.pid !== this.pid) throw new Error('This Pi is not the Herdr terminal foreground process');
    return terminal;
  }
  async context() {
    const terminal = await this.owner();
    return this.bindOrigin(await this.app(['ls']), terminal, this.pid, this.session);
  }
  async publish(label) {
    await this.owner();
    return runJson(process.env.HC_BIN || 'hc', ['label', process.env.HC_TERMINAL_ID, `herdr.pi=${JSON.stringify(label)}`, '--json']);
  }
  async workflow() { return this.command('workflow.get'); }
  async list(args) {
    const [agents, workflow] = await Promise.all([this.command('agent.list', args), this.workflow()]);
    return { ...agents, workflow };
  }
  async inspect(terminal, lines = 40) { return this.command('agent.inspect', { terminal, lines }); }
  async send(input) { return this.command('agent.send', input); }
  async stop(input) { return this.command('agent.stop', input); }
  async remove(input) {
    const { terminal, pid, session } = input;
    return this.command('agent.remove', { terminal, pid, session });
  }
  async launch(input) {
    const origin = await this.context();
    const common = { folder: input.folder, argv: ['pi', '--model', input.model, '--thinking', input.thinking], task: input.message, focus: false };
    if (input.space || !input.newSpace) {
      const space = input.space || origin.space;
      const result = await this.command('tab.new', { ...common, space, name: input.name });
      return { ...result, space: result.space || space };
    }
    return this.command('space.new', { ...common, name: input.newSpace.name, tab: input.name, machine: input.newSpace.machine ?? origin.machine ?? '' });
  }
}
