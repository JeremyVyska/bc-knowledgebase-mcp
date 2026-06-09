import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KNOWN_BC_MCPS } from '../../src/tools/_shared/workspace-constants.js';
import { createSetWorkspaceInfoHandler } from '../../src/tools/set_workspace_info/handler.js';
import { createGetWorkspaceInfoHandler } from '../../src/tools/get_workspace_info/handler.js';
import { setWorkspaceInfoTool, getWorkspaceInfoTool } from '../../src/tools/index.js';
import type { WorkspaceContext } from '../../src/tools/handlers.js';

// Define CallToolRequest type for tests
interface CallToolRequest {
  method: string;
  params: {
    name: string;
    arguments: any;
  };
}

describe('Workspace Management Tools', () => {
  let setWorkspaceInfoHandler: any;
  let getWorkspaceInfoHandler: any;
  let mockContext: WorkspaceContext;
  let setWorkspaceInfoSpy: any;
  let getWorkspaceInfoSpy: any;

  beforeEach(() => {
    // Create mock context with spies
    setWorkspaceInfoSpy = vi.fn().mockResolvedValue({
      success: true,
      message: 'Workspace configured successfully',
      reloaded: true
    });

    getWorkspaceInfoSpy = vi.fn().mockReturnValue({
      workspace_root: null,
      available_mcps: []
    });

    mockContext = {
      setWorkspaceInfo: setWorkspaceInfoSpy,
      getWorkspaceInfo: getWorkspaceInfoSpy
    };

    setWorkspaceInfoHandler = createSetWorkspaceInfoHandler(mockContext);
    getWorkspaceInfoHandler = createGetWorkspaceInfoHandler(mockContext);
  });

  describe('set_workspace_info', () => {
    it('should set workspace root successfully', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'set_workspace_info',
          arguments: {
            workspace_root: 'C:/projects/my-bc-app',
            available_mcps: []
          }
        }
      };

      const result = await setWorkspaceInfoHandler(request.params.arguments);

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.workspace_root).toBe('C:/projects/my-bc-app');
      expect(setWorkspaceInfoSpy).toHaveBeenCalledWith('C:/projects/my-bc-app', []);
    });

    it('should handle available_mcps parameter', async () => {
      const availableMcps = ['bc-telemetry-buddy', 'al-objid-mcp-server'];
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'set_workspace_info',
          arguments: {
            workspace_root: 'C:/projects/my-bc-app',
            available_mcps: availableMcps
          }
        }
      };

      const result = await setWorkspaceInfoHandler(request.params.arguments);
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(true);
      expect(response.mcp_ecosystem.total_available).toBe(2);
      expect(setWorkspaceInfoSpy).toHaveBeenCalledWith('C:/projects/my-bc-app', availableMcps);
    });

    it('should categorize known vs unknown MCPs', async () => {
      const availableMcps = [
        'bc-telemetry-buddy',         // Known
        'al-objid-mcp-server',        // Known
        'custom-company-mcp',         // Unknown
        'experimental-tool'           // Unknown
      ];

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'set_workspace_info',
          arguments: {
            workspace_root: 'C:/projects/my-bc-app',
            available_mcps: availableMcps
          }
        }
      };

      const result = await setWorkspaceInfoHandler(request.params.arguments);
      const response = JSON.parse(result.content[0].text);

      expect(response.mcp_ecosystem.total_available).toBe(4);
      expect(response.mcp_ecosystem.known_bc_mcps).toBe(2);
      expect(response.mcp_ecosystem.unknown_mcps).toBe(2);

      // Check known MCPs have descriptions
      expect(response.mcp_ecosystem.known).toHaveLength(2);
      expect(response.mcp_ecosystem.known[0].id).toBe('bc-telemetry-buddy');
      expect(response.mcp_ecosystem.known[0].description).toBe(KNOWN_BC_MCPS['bc-telemetry-buddy']);
      expect(response.mcp_ecosystem.known[1].id).toBe('al-objid-mcp-server');
      expect(response.mcp_ecosystem.known[1].description).toBe(KNOWN_BC_MCPS['al-objid-mcp-server']);

      // Check unknown MCPs listed
      expect(response.mcp_ecosystem.unknown).toContain('custom-company-mcp');
      expect(response.mcp_ecosystem.unknown).toContain('experimental-tool');
    });

    it('should provide ecosystem-aware response', async () => {
      setWorkspaceInfoSpy.mockResolvedValue({
        success: true,
        message: 'Workspace configured with MCP ecosystem',
        reloaded: true
      });

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'set_workspace_info',
          arguments: {
            workspace_root: 'C:/projects/my-bc-app',
            available_mcps: ['bc-telemetry-buddy', 'azure-devops-mcp']
          }
        }
      };

      const result = await setWorkspaceInfoHandler(request.params.arguments);
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(true);
      expect(response.reloaded).toBe(true);
      expect(response.mcp_ecosystem).toBeDefined();
      expect(response.mcp_ecosystem.known).toHaveLength(2);
    });

    it('should handle invalid workspace paths', async () => {
      setWorkspaceInfoSpy.mockResolvedValue({
        success: false,
        message: 'Path does not exist',
        reloaded: false
      });

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'set_workspace_info',
          arguments: {
            workspace_root: 'C:/nonexistent/path',
            available_mcps: []
          }
        }
      };

      const result = await setWorkspaceInfoHandler(request.params.arguments);
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.message).toContain('Path does not exist');
      expect(response.reloaded).toBe(false);
    });

    it('should require workspace_root parameter', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'set_workspace_info',
          arguments: {
            available_mcps: []
          }
        }
      };

      const result = await setWorkspaceInfoHandler(request.params.arguments);
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.error).toBe('workspace_root is required');
      expect(setWorkspaceInfoSpy).not.toHaveBeenCalled();
    });

    it('should require available_mcps parameter', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'set_workspace_info',
          arguments: {
            workspace_root: 'C:/projects/my-bc-app'
          }
        }
      };

      const result = await setWorkspaceInfoHandler(request.params.arguments);
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.error).toBe('available_mcps is required');
      expect(setWorkspaceInfoSpy).not.toHaveBeenCalled();
    });

    it('should accept workspace_path as an alias for workspace_root', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'set_workspace_info',
          arguments: {
            workspace_path: 'C:/projects/my-bc-app',
            available_mcps: []
          }
        }
      };

      const result = await setWorkspaceInfoHandler(request.params.arguments);
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(true);
      expect(response.workspace_root).toBe('C:/projects/my-bc-app');
      expect(setWorkspaceInfoSpy).toHaveBeenCalledWith('C:/projects/my-bc-app', []);
    });

    it('should prefer workspace_root when both workspace_root and workspace_path are provided', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'set_workspace_info',
          arguments: {
            workspace_root: 'C:/projects/primary',
            workspace_path: 'C:/projects/alias',
            available_mcps: []
          }
        }
      };

      const result = await setWorkspaceInfoHandler(request.params.arguments);
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(true);
      expect(response.workspace_root).toBe('C:/projects/primary');
      expect(setWorkspaceInfoSpy).toHaveBeenCalledWith('C:/projects/primary', []);
    });

    it('should still require a path when neither workspace_root nor workspace_path is provided', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'set_workspace_info',
          arguments: {
            available_mcps: []
          }
        }
      };

      const result = await setWorkspaceInfoHandler(request.params.arguments);
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.error).toBe('workspace_root is required');
      expect(setWorkspaceInfoSpy).not.toHaveBeenCalled();
    });

    it('should trigger layer reload when configured', async () => {
      setWorkspaceInfoSpy.mockResolvedValue({
        success: true,
        message: 'Configuration reloaded with 3 layers',
        reloaded: true
      });

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'set_workspace_info',
          arguments: {
            workspace_root: 'C:/projects/my-bc-app',
            available_mcps: []
          }
        }
      };

      const result = await setWorkspaceInfoHandler(request.params.arguments);
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(true);
      expect(response.reloaded).toBe(true);
      expect(setWorkspaceInfoSpy).toHaveBeenCalled();
    });

    it('should handle empty available_mcps array', async () => {
      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'set_workspace_info',
          arguments: {
            workspace_root: 'C:/projects/my-bc-app',
            available_mcps: []
          }
        }
      };

      const result = await setWorkspaceInfoHandler(request.params.arguments);
      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(true);
      expect(response.mcp_ecosystem.total_available).toBe(0);
      expect(response.mcp_ecosystem.known).toHaveLength(0);
      expect(response.mcp_ecosystem.unknown).toHaveLength(0);
    });
  });

  describe('get_workspace_info', () => {
    it('should return WorkspaceInfo structure when workspace not set', async () => {
      getWorkspaceInfoSpy.mockReturnValue({
        workspace_root: null,
        available_mcps: []
      });

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'get_workspace_info',
          arguments: {}
        }
      };

      const result = await getWorkspaceInfoHandler(request.params.arguments);
      const response = JSON.parse(result.content[0].text);

      expect(response.workspace_root).toBeNull();
      expect(response.is_set).toBe(false);
      expect(response.available_mcps).toEqual([]);
      expect(response.mcp_ecosystem.total_available).toBe(0);
      expect(response.message).toContain('No workspace configured');
    });

    it('should return workspace_root and available_mcps when set', async () => {
      getWorkspaceInfoSpy.mockReturnValue({
        workspace_root: 'C:/projects/my-bc-app',
        available_mcps: ['bc-telemetry-buddy', 'al-objid-mcp-server']
      });

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'get_workspace_info',
          arguments: {}
        }
      };

      const result = await getWorkspaceInfoHandler(request.params.arguments);
      const response = JSON.parse(result.content[0].text);

      expect(response.workspace_root).toBe('C:/projects/my-bc-app');
      expect(response.is_set).toBe(true);
      expect(response.available_mcps).toHaveLength(2);
      expect(response.mcp_ecosystem.total_available).toBe(2);
      expect(response.mcp_ecosystem.known_bc_mcps).toHaveLength(2);
      expect(response.message).toContain('Workspace root: C:/projects/my-bc-app');
      expect(response.message).toContain('Available MCPs: 2');
    });

    it('should include ecosystem categorization', async () => {
      getWorkspaceInfoSpy.mockReturnValue({
        workspace_root: 'C:/projects/my-bc-app',
        available_mcps: ['bc-telemetry-buddy', 'custom-mcp']
      });

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'get_workspace_info',
          arguments: {}
        }
      };

      const result = await getWorkspaceInfoHandler(request.params.arguments);
      const response = JSON.parse(result.content[0].text);

      expect(response.mcp_ecosystem.known_bc_mcps).toHaveLength(1);
      expect(response.mcp_ecosystem.known_bc_mcps[0].id).toBe('bc-telemetry-buddy');
      expect(response.mcp_ecosystem.known_bc_mcps[0].description).toBeDefined();
      expect(response.mcp_ecosystem.unknown_mcps).toContain('custom-mcp');
    });

    it('should handle workspace set without MCPs', async () => {
      getWorkspaceInfoSpy.mockReturnValue({
        workspace_root: 'C:/projects/my-bc-app',
        available_mcps: []
      });

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'get_workspace_info',
          arguments: {}
        }
      };

      const result = await getWorkspaceInfoHandler(request.params.arguments);
      const response = JSON.parse(result.content[0].text);

      expect(response.workspace_root).toBe('C:/projects/my-bc-app');
      expect(response.is_set).toBe(true);
      expect(response.available_mcps).toEqual([]);
      expect(response.message).not.toContain('Available MCPs');
    });
  });

  describe('Tool Definitions', () => {
    it('should provide set_workspace_info tool definition', () => {
      expect(setWorkspaceInfoTool).toBeDefined();
      expect(setWorkspaceInfoTool.name).toBe('set_workspace_info');
      expect(setWorkspaceInfoTool.description).toContain('workspace root');
      expect(setWorkspaceInfoTool.inputSchema.properties.workspace_root).toBeDefined();
      expect(setWorkspaceInfoTool.inputSchema.properties.workspace_path).toBeDefined();
      expect(setWorkspaceInfoTool.inputSchema.properties.available_mcps).toBeDefined();
      expect(setWorkspaceInfoTool.inputSchema.required).toContain('workspace_root');
    });

    it('should provide get_workspace_info tool definition', () => {
      expect(getWorkspaceInfoTool).toBeDefined();
      expect(getWorkspaceInfoTool.name).toBe('get_workspace_info');
      expect(getWorkspaceInfoTool.description).toContain('workspace root');
      expect(getWorkspaceInfoTool.inputSchema.properties).toEqual({});
      expect(getWorkspaceInfoTool.inputSchema.required).toEqual([]);
    });
  });

  describe('KNOWN_BC_MCPS Registry', () => {
    it('should contain 8 known BC MCP servers', () => {
      const knownMcps = Object.keys(KNOWN_BC_MCPS);
      expect(knownMcps).toHaveLength(8);
    });

    it('should provide descriptions for all known MCPs', () => {
      const expectedMcps = [
        'bc-code-intelligence-mcp',
        'al-dependency-mcp-server',
        'serena-mcp',
        'al-objid-mcp-server',
        'bc-telemetry-buddy',
        'azure-devops-mcp',
        'clockify-mcp',
        'nab-al-tools-mcp'
      ];

      for (const mcpId of expectedMcps) {
        expect(KNOWN_BC_MCPS).toHaveProperty(mcpId);
        expect(KNOWN_BC_MCPS[mcpId as keyof typeof KNOWN_BC_MCPS]).toBeDefined();
        expect(typeof KNOWN_BC_MCPS[mcpId as keyof typeof KNOWN_BC_MCPS]).toBe('string');
        expect(KNOWN_BC_MCPS[mcpId as keyof typeof KNOWN_BC_MCPS].length).toBeGreaterThan(0);
      }
    });

    it('should handle registry lookups correctly', () => {
      expect(KNOWN_BC_MCPS['bc-telemetry-buddy']).toContain('telemetry');
      expect(KNOWN_BC_MCPS['al-objid-mcp-server']).toContain('Object ID');
      expect(KNOWN_BC_MCPS['azure-devops-mcp']).toContain('Azure DevOps');
    });
  });

  describe('MCP Categorization', () => {
    it('should categorize all known MCPs with descriptions', () => {
      const allKnownMcps = Object.keys(KNOWN_BC_MCPS);
      getWorkspaceInfoSpy.mockReturnValue({
        workspace_root: 'C:/projects/test',
        available_mcps: allKnownMcps
      });

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'get_workspace_info',
          arguments: {}
        }
      };

      const result = getWorkspaceInfoHandler(request.params.arguments);
      return result.then(res => {
        const response = JSON.parse(res.content[0].text);

        expect(response.mcp_ecosystem.known_bc_mcps).toHaveLength(8);
        expect(response.mcp_ecosystem.unknown_mcps).toHaveLength(0);

        for (const mcp of response.mcp_ecosystem.known_bc_mcps) {
          expect(mcp.id).toBeDefined();
          expect(mcp.description).toBeDefined();
          expect(mcp.description.length).toBeGreaterThan(0);
        }
      });
    });

    it('should list unknown MCPs separately', () => {
      getWorkspaceInfoSpy.mockReturnValue({
        workspace_root: 'C:/projects/test',
        available_mcps: ['unknown-tool-1', 'unknown-tool-2']
      });

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'get_workspace_info',
          arguments: {}
        }
      };

      const result = getWorkspaceInfoHandler(request.params.arguments);
      return result.then(res => {
        const response = JSON.parse(res.content[0].text);

        expect(response.mcp_ecosystem.known_bc_mcps).toHaveLength(0);
        expect(response.mcp_ecosystem.unknown_mcps).toHaveLength(2);
        expect(response.mcp_ecosystem.unknown_mcps).toContain('unknown-tool-1');
        expect(response.mcp_ecosystem.unknown_mcps).toContain('unknown-tool-2');
      });
    });

    it('should handle mixed known/unknown MCPs', () => {
      getWorkspaceInfoSpy.mockReturnValue({
        workspace_root: 'C:/projects/test',
        available_mcps: [
          'bc-telemetry-buddy',      // Known
          'custom-company-tool',     // Unknown
          'al-objid-mcp-server',     // Known
          'experimental-mcp'         // Unknown
        ]
      });

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'get_workspace_info',
          arguments: {}
        }
      };

      const result = getWorkspaceInfoHandler(request.params.arguments);
      return result.then(res => {
        const response = JSON.parse(res.content[0].text);

        expect(response.mcp_ecosystem.total_available).toBe(4);
        expect(response.mcp_ecosystem.known_bc_mcps).toHaveLength(2);
        expect(response.mcp_ecosystem.unknown_mcps).toHaveLength(2);

        const knownIds = response.mcp_ecosystem.known_bc_mcps.map((m: any) => m.id);
        expect(knownIds).toContain('bc-telemetry-buddy');
        expect(knownIds).toContain('al-objid-mcp-server');

        expect(response.mcp_ecosystem.unknown_mcps).toContain('custom-company-tool');
        expect(response.mcp_ecosystem.unknown_mcps).toContain('experimental-mcp');
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle context errors gracefully', async () => {
      setWorkspaceInfoSpy.mockRejectedValue(new Error('Context error'));

      const request: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'set_workspace_info',
          arguments: {
            workspace_root: 'C:/projects/my-bc-app',
            available_mcps: []
          }
        }
      };

      await expect(setWorkspaceInfoHandler(request.params.arguments)).rejects.toThrow('Context error');
    });
  });

  describe('Integration Scenarios', () => {
    it('should handle typical user flow: set then get workspace', async () => {
      // Step 1: Set workspace
      setWorkspaceInfoSpy.mockResolvedValue({
        success: true,
        message: 'Workspace configured',
        reloaded: true
      });

      const setRequest: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'set_workspace_info',
          arguments: {
            workspace_root: 'C:/projects/my-bc-app',
            available_mcps: ['bc-telemetry-buddy']
          }
        }
      };

      const setResult = await setWorkspaceInfoHandler(setRequest.params.arguments);
      const setResponse = JSON.parse(setResult.content[0].text);
      expect(setResponse.success).toBe(true);

      // Step 2: Get workspace (simulate updated state)
      getWorkspaceInfoSpy.mockReturnValue({
        workspace_root: 'C:/projects/my-bc-app',
        available_mcps: ['bc-telemetry-buddy']
      });

      const getRequest: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'get_workspace_info',
          arguments: {}
        }
      };

      const getResult = await getWorkspaceInfoHandler(getRequest.params.arguments);
      const getResponse = JSON.parse(getResult.content[0].text);

      expect(getResponse.workspace_root).toBe('C:/projects/my-bc-app');
      expect(getResponse.is_set).toBe(true);
      expect(getResponse.available_mcps).toContain('bc-telemetry-buddy');
    });

    it('should handle workspace update with different MCPs', async () => {
      // Initial workspace with 2 MCPs
      setWorkspaceInfoSpy.mockResolvedValue({
        success: true,
        message: 'Workspace configured',
        reloaded: true
      });

      const firstRequest: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'set_workspace_info',
          arguments: {
            workspace_root: 'C:/projects/my-bc-app',
            available_mcps: ['bc-telemetry-buddy', 'al-objid-mcp-server']
          }
        }
      };

      await setWorkspaceInfoHandler(firstRequest.params.arguments);

      // Update with 3 MCPs
      const secondRequest: CallToolRequest = {
        method: 'tools/call',
        params: {
          name: 'set_workspace_info',
          arguments: {
            workspace_root: 'C:/projects/my-bc-app',
            available_mcps: ['bc-telemetry-buddy', 'al-objid-mcp-server', 'azure-devops-mcp']
          }
        }
      };

      const result = await setWorkspaceInfoHandler(secondRequest.params.arguments);
      const response = JSON.parse(result.content[0].text);

      expect(response.mcp_ecosystem.total_available).toBe(3);
      expect(response.mcp_ecosystem.known_bc_mcps).toBe(3);
    });
  });
});
