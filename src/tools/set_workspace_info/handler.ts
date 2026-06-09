/**
 * set_workspace_info Tool - Handler Implementation
 *
 * Set workspace root directory and list of available MCP servers
 */

import { KNOWN_BC_MCPS, KnownMcpServerId, WorkspaceInfo } from '../_shared/workspace-constants.js';

export interface SetWorkspaceInfoContext {
  setWorkspaceInfo: (path: string, availableMcps?: string[]) => Promise<{ success: boolean; message: string; reloaded: boolean }>;
}

export function createSetWorkspaceInfoHandler(services: any) {
  const context = services as SetWorkspaceInfoContext;

  return async (args: { workspace_root?: string; workspace_path?: string; available_mcps?: string[] }) => {
    // Accept `workspace_path` as a backward-compatible alias for `workspace_root`.
    // `workspace_root` takes precedence when both are supplied.
    const workspace_root = args.workspace_root ?? args.workspace_path;
    const { available_mcps } = args;

    if (!workspace_root) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: false,
            error: 'workspace_root is required'
          }, null, 2)
        }]
      };
    }

    if (available_mcps === undefined) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: false,
            error: 'available_mcps is required'
          }, null, 2)
        }]
      };
    }

    // Validate and categorize MCPs
    const knownMcps = available_mcps.filter(mcp => mcp in KNOWN_BC_MCPS);
    const unknownMcps = available_mcps.filter(mcp => !(mcp in KNOWN_BC_MCPS));

    const result = await context.setWorkspaceInfo(workspace_root, available_mcps);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          success: result.success,
          message: result.message,
          reloaded: result.reloaded,
          workspace_root,
          mcp_ecosystem: {
            total_available: available_mcps.length,
            known_bc_mcps: knownMcps.length,
            unknown_mcps: unknownMcps.length,
            known: knownMcps.map(id => ({
              id,
              description: KNOWN_BC_MCPS[id as KnownMcpServerId]
            })),
            unknown: unknownMcps
          }
        }, null, 2)
      }]
    };
  };
}
