// Read-only probe executed on the machine whose Workflow models are requested.
// Runtime discovery is shared with the installer and injected before execution.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
__HERDR_DISCOVERY__

async function catalog() {
  const runtime = await discoverPiRuntime();
  if (!runtime.launch) throw new Error(runtime.launchError);
  let directory = path.dirname(runtime.launch[1]);
  let sdk;
  for (let level = 0; level < 8; level++) {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      if (metadata.name === '@earendil-works/pi-coding-agent') {
        sdk = await import(pathToFileURL(path.resolve(directory, metadata.main)).href);
        break;
      }
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!sdk?.ModelRuntime || !sdk?.SettingsManager || !sdk?.resolveModelScopeWithDiagnostics) {
    throw new Error('The installed Pi does not expose its model catalog SDK. Update Pi or enter provider/model manually.');
  }
  const configured = process.env.PI_CODING_AGENT_DIR;
  const agent = configured ? path.resolve(configured === '~' ? os.homedir() : configured.startsWith('~/') || configured.startsWith('~\\') ? path.join(os.homedir(), configured.slice(2)) : configured) : path.join(os.homedir(), '.pi', 'agent');
  // Workflow profiles are app-wide, not tied to a project or a running session.
  const settings = sdk.SettingsManager.create(os.homedir(), agent, { projectTrusted: false });
  const errors = settings.drainErrors();
  if (errors.length) throw new Error(errors.map(item => `${item.path ?? item.scope}: ${item.error.message}`).join('; '));
  const patterns = settings.getGlobalSettings().enabledModels;
  const fromPi = createRequire(path.join(directory, 'package.json'));
  const { InMemoryCredentialStore } = await import(pathToFileURL(fromPi.resolve('@earendil-works/pi-ai')).href);
  const models = await sdk.ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: path.join(agent, 'models.json'),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  if (models.getError()) throw new Error(models.getError());
  // Selection is not a launch: do not filter configured models by credentials,
  // refresh OAuth tokens, fetch remote catalogs, or load the user's extensions.
  const all = models.getModels();
  const scope = patterns?.length
    ? await sdk.resolveModelScopeWithDiagnostics(patterns, { getAvailable: async () => all })
    : { scopedModels: all.map(model => ({ model })), diagnostics: [] };
  const choices = [...new Map(scope.scopedModels.map(({ model }) => [
    `${model.provider}/${model.id}`, { id: `${model.provider}/${model.id}`, name: model.name ?? model.id },
  ])).values()];
  return { models: choices, source: 'pi-settings', diagnostics: scope.diagnostics };
}
catalog().catch(error => ({ models: [], source: 'pi-settings', error: `Cannot read Pi models: ${error.message}. You can still enter provider/model manually.` }))
  .then(result => process.stdout.write('\nherdr-pi-models:' + JSON.stringify(result) + '\n'));
