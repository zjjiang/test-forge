import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./server.js";

const server = new McpServer(
  { name: "testforge", version: "0.1.0" },
  { instructions: "TestForge 场景驱动测试平台：查项目/场景、触发与等待执行、读取报告与截图、读写场景 YAML 与业务描述。" },
);
registerTools(server);

await server.connect(new StdioServerTransport());
