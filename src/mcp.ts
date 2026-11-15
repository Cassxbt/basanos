import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadContest, CONTESTS } from "./contests.ts";
import { precheck } from "./precheck.ts";
import { toReport, toText } from "./format.ts";

try {
  process.loadEnvFile();
} catch {
  // Keys come from the MCP client's env block instead.
}

const server = new McpServer({ name: "basanos", version: "0.1.0" });

server.registerTool(
  "basanos_contests",
  {
    description: "List the audit contests Basanos can check reports against (repository and audited commit).",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: JSON.stringify(CONTESTS.map(({ snapshot, ...c }) => c), null, 2) }],
  }),
);

server.registerTool(
  "basanos_precheck",
  {
    description:
      "Check an audit-contest finding before submitting it. Resolves every code link against the audited commit, " +
      "reads the full in-scope source for evidence, and returns one bounded verdict " +
      "(READY, NEEDS_PROOF, BLOCKED_BY_CODE, KNOWN_OR_OUT_OF_SCOPE, CITATION_BROKEN, GUARD_HELD) " +
      "with the specific evidence a judge would still need. It does not submit anything.",
    inputSchema: {
      contest: z.string().describe("Contest id from basanos_contests, e.g. karak"),
      title: z.string().max(300).describe("Finding title"),
      report: z.string().max(60_000).describe("Full finding body in markdown, including GitHub code links"),
    },
  },
  async ({ contest, title, report }) => {
    const { contest: c, policy } = loadContest(contest);
    const result = await precheck({ title, body: report }, c, policy);
    return {
      content: [
        { type: "text", text: toText(result) },
        { type: "text", text: JSON.stringify(toReport(result, contest, c.auditedCommit, title, report)) },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
