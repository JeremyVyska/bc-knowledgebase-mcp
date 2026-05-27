import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

interface JsonRpcMessage {
  id?: number;
  result?: any;
  error?: any;
}

interface StdioProbe {
  callTool(name: string, args: Record<string, unknown>): Promise<JsonRpcMessage>;
  close(): void;
  anomalies: string[];
}

async function createStdioProbe(): Promise<StdioProbe> {
  const serverPath = resolve(process.cwd(), 'dist/index.js');

  if (!existsSync(serverPath)) {
    throw new Error('dist/index.js not found. Run npm run build before integration tests.');
  }

  const child = spawn(process.execPath, [serverPath], {
    cwd: process.cwd(),
    env: { ...process.env, MCP_SERVER_MODE: 'stdio' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return initializeProbe(child);
}

async function initializeProbe(child: ChildProcessWithoutNullStreams): Promise<StdioProbe> {
  let stdoutBuffer = '';
  let nextId = 1;
  const anomalies: string[] = [];
  const messages: JsonRpcMessage[] = [];

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');

    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        try {
          messages.push(JSON.parse(line));
        } catch {
          anomalies.push(line);
        }
      }

      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  const send = (method: string, params: Record<string, unknown>): number => {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return id;
  };

  const notify = (method: string, params: Record<string, unknown>): void => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };

  const waitFor = (id: number, timeoutMs = 30000): Promise<JsonRpcMessage> =>
    new Promise((resolveMessage, reject) => {
      const startedAt = Date.now();
      const interval = setInterval(() => {
        const message = messages.find((item) => item.id === id);
        if (message) {
          clearInterval(interval);
          resolveMessage(message);
          return;
        }

        if (Date.now() - startedAt > timeoutMs) {
          clearInterval(interval);
          reject(new Error(`Timed out waiting for JSON-RPC response ${id}`));
        }
      }, 25);
    });

  const initializeId = send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'stdio-cleanliness-test', version: '1.0.0' },
  });

  await waitFor(initializeId);
  notify('notifications/initialized', {});

  return {
    anomalies,
    callTool: async (name: string, args: Record<string, unknown>): Promise<JsonRpcMessage> => {
      const id = send('tools/call', { name, arguments: args });
      return waitFor(id);
    },
    close: (): void => {
      child.kill();
    },
  };
}

describe('MCP stdio transport cleanliness', () => {
  it('keeps diagnostic logging off stdout during code analysis tool calls', async () => {
    const probe = await createStdioProbe();

    try {
      const setWorkspace = await probe.callTool('set_workspace_info', {
        workspace_root: process.cwd(),
        available_mcps: [],
      });
      expect(setWorkspace.error).toBeUndefined();

      const askExpert = await probe.callTool('ask_bc_expert', {
        preferred_specialist: 'performance-expert',
        question: 'Is this AL loop performance-safe?',
        context: [
          'codeunit 50100 Test',
          '{',
          '    procedure Run()',
          '    var',
          '        SalesLine: Record "Sales Line";',
          '    begin',
          '        SalesLine.SetRange("Document Type", SalesLine."Document Type"::Order);',
          '        SalesLine.SetLoadFields("Document No.", "Line No.", Amount);',
          '        if SalesLine.FindSet() then',
          '            repeat',
          '                if SalesLine.Amount > 0 then',
          '                    Message(\'%1\', SalesLine."Document No.");',
          '            until SalesLine.Next() = 0;',
          '    end;',
          '}',
        ].join('\n'),
      });
      expect(askExpert.error).toBeUndefined();

      const analyzeWorkspace = await probe.callTool('analyze_al_code', {
        workspace_path: process.cwd(),
      });
      expect(analyzeWorkspace.error).toBeUndefined();

      expect(probe.anomalies).toEqual([]);
    } finally {
      probe.close();
    }
  }, 45000);
});
