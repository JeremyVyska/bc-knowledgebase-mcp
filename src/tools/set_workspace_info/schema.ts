/**
 * set_workspace_info Tool - Schema Definition
 *
 * Set workspace root directory and list of available MCP servers
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';

export const setWorkspaceInfoTool: Tool = {
  name: 'set_workspace_info',
  description: 'Set workspace root directory and available MCP server IDs. Enables project-specific knowledge layers and ecosystem-aware specialist recommendations. Call before other BC tools to activate workspace context.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_root: {
        type: 'string',
        description: 'Absolute path to the workspace/project root directory (e.g., C:/projects/my-bc-app or /home/user/projects/my-bc-app)'
      },
      workspace_path: {
        type: 'string',
        description: 'Alias for workspace_root. Accepted for backward compatibility; if both are provided, workspace_root takes precedence.'
      },
      available_mcps: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of MCP server IDs available in your context (e.g., ["bc-telemetry-buddy", "al-objid-mcp-server"])'
      }
    },
    required: ['workspace_root', 'available_mcps']
  }
};
