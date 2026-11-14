import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
export default function(pi: ExtensionAPI) {
  pi.registerTool({ name: 'herdr_catalog_probe', label: 'Herdr catalog probe', description: 'Inspect and activate the deferred Herdr catalog', parameters: Type.Object({}),
    async execute() {
      const tools = pi.getAllTools().filter(tool => tool.name.startsWith('herdr_agent_'));
      const active = pi.getActiveTools();
      pi.setActiveTools([...active, 'herdr_agent_list']);
      return { content: [{type:'text',text:JSON.stringify({tools,active})}], details: {tools,active} };
    }
  });
}
