import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ToolContext } from "./context.js";
import { SchemaCache } from "./graphql-schema.js";
import { OdpClient, type OdpConnection } from "./odp-client.js";
import { loadSettings, REGION_HOSTS, type Region, type Settings } from "./settings.js";
import { registerExportTools } from "./tools/exports.js";
import { registerGraphqlTools } from "./tools/graphql.js";
import { registerRestTools } from "./tools/rest.js";

const VERSION = "0.2.0";

const INSTRUCTIONS = `Read access to Optimizely Data Platform (ODP) customer data for the ODP account whose API key this connection uses.
- Discover the account's data model with odp_graphql_schema_overview / odp_graphql_describe_type (GraphQL) or odp_list_objects / odp_list_fields (REST).
- Query customers, events, orders, products and custom objects with odp_graphql_query, odp_graphql_get_customer or odp_graphql_list.
- GraphQL pages are capped at 1000 records; for bulk data start an export job (odp_start_data_export) and poll its status.
- Real-time segment membership: customer(...) { audiences(subset: [...]) { edges { node { name } } } }.`;

/** Request headers clients use to supply their ODP credentials. */
const HEADER_API_KEY = "x-odp-api-key";
const HEADER_REGION = "x-odp-region";

function buildServer(ctx: ToolContext, schemas: SchemaCache): McpServer {
  const server = new McpServer({ name: "odp-mcp", version: VERSION }, { instructions: INSTRUCTIONS });
  registerGraphqlTools(server, ctx, schemas);
  registerRestTools(server, ctx);
  registerExportTools(server, ctx);
  return server;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

/** Builds the caller's ODP connection from its request headers. */
function connectionFrom(req: IncomingMessage, settings: Settings): OdpConnection {
  const apiKey = header(req, HEADER_API_KEY);
  // 400 rather than 401: a 401 makes OAuth-capable clients (mcp-remote, Claude Code) start an OAuth flow.
  if (!apiKey) throw new HttpError(400, "Missing X-ODP-API-Key header: send your ODP private API key (ODP: Settings > APIs).");

  const region = (header(req, HEADER_REGION)?.toLowerCase() ?? "us") as Region;
  if (!(region in REGION_HOSTS)) {
    throw new HttpError(400, `Invalid X-ODP-Region header "${region}": expected one of ${Object.keys(REGION_HOSTS).join(", ")}.`);
  }

  const host = (settings.ODP_MCP_UPSTREAM_OVERRIDE ?? REGION_HOSTS[region]).replace(/\/+$/, "");
  return { apiKey, region, host };
}

function checkServerToken(req: IncomingMessage, token: string | undefined): void {
  if (!token) return;
  const given = Buffer.from(header(req, "authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    // 403 rather than 401 for the same OAuth reason as above.
    throw new HttpError(403, "Missing or invalid Authorization header for this MCP server.");
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) return;
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function main() {
  const settings = loadSettings();
  const schemas = new SchemaCache();

  const httpServer = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      // Stateless server: no standalone SSE stream and no sessions to resume or delete.
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }

    try {
      checkServerToken(req, settings.ODP_MCP_AUTH_TOKEN);
      const ctx = new ToolContext(settings, new OdpClient(connectionFrom(req, settings)));
      const body = await readJson(req);

      // Stateless: a fresh MCP server per request, bound to this caller's credentials.
      const server = buildServer(ctx, schemas);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJsonRpcError(res, err.status, err.message);
      } else {
        console.error("MCP request failed:", err);
        sendJsonRpcError(res, 500, "Internal server error.");
      }
    }
  });

  httpServer.listen(settings.PORT, settings.HOST, () => {
    const notes = [
      settings.ODP_MCP_AUTH_TOKEN ? "server token required" : "no server token",
      settings.ODP_MCP_ALLOW_MUTATIONS ? "mutations ENABLED" : "read-only",
      settings.ODP_MCP_UPSTREAM_OVERRIDE ? `upstream override ${settings.ODP_MCP_UPSTREAM_OVERRIDE}` : undefined,
    ].filter(Boolean);
    console.error(`odp-mcp ${VERSION} listening on http://${settings.HOST}:${settings.PORT}/mcp (${notes.join(", ")})`);
  });

  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

try {
  main();
} catch (err) {
  console.error(`odp-mcp failed to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
