import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
export default function(pi: ExtensionAPI) {
  pi.registerTool({ name: 'herdr_catalog_probe', label: 'Herdr catalog probe', description: 'Inspect and activate the deferred Herdr catalog', parameters: Type.Object({}),
    async execute() {
      const tools = pi.getAllTools().filter(tool => tool.name === 'agent');
      const active = pi.getActiveTools();
      pi.setActiveTools([...active, 'agent']);
      return { content: [{type:'text',text:JSON.stringify({tools,active})}], details: {tools,active} };
    }
  });
}
