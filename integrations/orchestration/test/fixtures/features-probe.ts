import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export default function featureProbe(pi: ExtensionAPI): void {
  let sections: string[] = [];
  pi.on('before_agent_start', event => { sections = Object.keys(event.systemPromptOptions.sections); });
  pi.registerTool({
    name: 'feature_probe', label: 'Feature probe', description: 'Read the live integration catalog and prompt section keys.', parameters: Type.Object({}),
    async execute() {
      const details = { tools: pi.getAllTools().filter(tool => tool.name.startsWith('herdr_agent_')).map(tool => tool.name), sections };
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    },
  });
}
