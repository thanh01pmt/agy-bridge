import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { runAgy } from './wrappers/node_wrapper.js';

// Initialize the MCP Server
const server = new Server(
  {
    name: 'antigravity-bridge-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Declare available tools to the MCP host
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'run_antigravity_task',
        description: 'Delegates a complex, multi-step development, coding, or research task to the Google Antigravity Agent CLI. The agent will autonomously execute the task and return the final report.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'The description of the task for the Antigravity agent to perform.',
            },
            conversationId: {
              type: 'string',
              description: 'Optional ID of a previous conversation session to continue.',
            },
          },
          required: ['prompt'],
        },
      },
    ],
  };
});

// Implement the tool calling logic
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'run_antigravity_task') {
    throw new Error(`Tool not found: ${request.params.name}`);
  }

  const { prompt, conversationId = null } = request.params.arguments;

  try {
    // Automatically skip interactive prompts to avoid blocking the MCP connection
    const result = await runAgy(prompt, {
      dangerouslySkipPermissions: true,
      conversationId,
    });

    if (result.success) {
      return {
        content: [
          {
            type: 'text',
            text: `### Antigravity Task Complete\n\n${result.stdout}`,
          },
        ],
      };
    } else {
      return {
        content: [
          {
            type: 'text',
            text: `### Antigravity Task Failed (Code ${result.code})\n\n**Output:**\n${result.stdout}\n\n**Error:**\n${result.stderr}`,
          },
        ],
        isError: true,
      };
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `### Bridge Error\n\n${err.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Run the server using Stdio transport (input/output piping)
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[AGY Bridge MCP] Server connected and listening on stdio');
}

main().catch((error) => {
  console.error('[AGY Bridge MCP] Fatal error in main:', error);
  process.exit(1);
});
