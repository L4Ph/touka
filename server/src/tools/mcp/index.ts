import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { McpConnector } from "@remote-agent/connector-mcp";
import type { ToolContext } from "../../tools";

export function create(context: ToolContext) {
  const connector = new McpConnector(context.env, context);
  const output = (value: unknown) => ({
    output: [{ type: "text" as const, text: JSON.stringify(value) }],
  });
  return defineExtension({
    name: "mcp",
    tools: [
      defineTool({
        name: "mcp_list_tools",
        description:
          "List authorized MCP servers, or discover the permitted tools and input schemas of one server. Server credentials are managed by the operator.",
        replay: "safe",
        parameters: Type.Object(
          { server: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })) },
          { additionalProperties: false },
        ),
        execute: async ({ server }, _api, execution) =>
          output(
            server
              ? await connector.listTools(server, execution?.abortSignal)
              : connector.servers(),
          ),
      }),
      defineTool({
        name: "mcp_call_tool",
        description:
          "Call one explicitly authorized MCP tool using its discovered input schema. Calls can have side effects and are never replayed automatically.",
        replay: "unsafe",
        parameters: Type.Object(
          {
            server: Type.String({ minLength: 1, maxLength: 64 }),
            tool: Type.String({ minLength: 1, maxLength: 128 }),
            arguments: Type.Record(Type.String(), Type.Unknown()),
          },
          { additionalProperties: false },
        ),
        execute: async ({ server, tool, arguments: args }, _api, execution) => {
          const result = await connector.callTool(server, tool, args, execution?.abortSignal);
          return { ...output(result), isError: result.isError === true };
        },
      }),
    ],
  });
}
