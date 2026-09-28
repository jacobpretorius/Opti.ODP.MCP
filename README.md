# ODP MCP server

An [MCP](https://modelcontextprotocol.io) server for **Optimizely Data Platform (ODP)**. It gives MCP clients (Claude Desktop, Claude Code, and others) read access to ODP data through the ODP GraphQL API and the read endpoints of the ODP REST API.

It is written in TypeScript and runs as one long-running Docker container. The container holds no configuration and no secrets. Each client sends its own ODP API key and region with every request, so any number of clients, for any number of ODP accounts, can share one server.

> This is an unofficial community project. It is not affiliated with, endorsed by or supported by Optimizely. Optimizely and Optimizely Data Platform are trademarks of their owner.

## What it can do

| Area | Tools |
| --- | --- |
| GraphQL | `odp_graphql_query` (any query), `odp_graphql_schema_overview`, `odp_graphql_describe_type`, `odp_graphql_get_customer`, `odp_graphql_list` (paged list of any dimension with a filter) |
| Customers | `odp_get_customer_profile`, `odp_get_consent`, `odp_get_reachability`, `odp_get_identifier_metadata` |
| Lists | `odp_list_lists`, `odp_get_list_subscriptions` |
| Schema | `odp_list_objects`, `odp_get_object`, `odp_list_fields`, `odp_get_field`, `odp_list_relations`, `odp_get_relation` |
| Real-time segments | `odp_list_segments`, `odp_get_segment` |
| Recommendations | `odp_get_recommended_products` |
| Compliance | `odp_get_compliance_request_status` (GDPR, CCPA, LGPD) |
| Exports (bulk reads) | `odp_start_data_export`, `odp_get_export_status`, `odp_start_segment_export`, `odp_get_segment_export_status` |

GraphQL is the main way to query customer data. The server reads each account's schema through introspection, so custom objects and fields are available without extra setup. A GraphQL page holds at most 1,000 records. For larger reads, use the export tools. They write files to ODP's S3 bucket; segment exports return presigned download URLs.

The server is read-only. GraphQL mutations are rejected unless the operator sets `ODP_MCP_ALLOW_MUTATIONS=true`. The REST tools that change data (upload events, update customers, subscribe, create segments, and so on) are not included yet.

## How clients authenticate

The MCP endpoint is `POST /mcp` (Streamable HTTP, stateless). Every request must carry the caller's ODP credentials as headers:

| Header | Required | Value |
| --- | --- | --- |
| `X-ODP-API-Key` | yes | The ODP account's **private** API key (in ODP: **Settings > APIs**). |
| `X-ODP-Region` | no | `us` (default), `eu` or `au`: the region of the ODP account. It matches the host in the ODP app's URL. |
| `Authorization` | only if the operator set `ODP_MCP_AUTH_TOKEN` | `Bearer <ODP_MCP_AUTH_TOKEN>` |

The server forwards the key to ODP as `x-api-key` and never stores or logs it. One connection works with one ODP account. To use several accounts, add one MCP server entry per account in your client, each with its own key.

If a header is missing or invalid, the server returns HTTP 400 with a message saying what is wrong. If the key is wrong, ODP rejects the call and the tool returns ODP's error.

## Run the server

```sh
docker compose up -d --build
```

The container is named `odp-mcp` and uses the `unless-stopped` restart policy, so it comes back whenever Docker starts. To have it available after a reboot, turn on Docker Desktop's **Start Docker Desktop when you sign in** setting. The port is published on `127.0.0.1` only.

To check that it is running:

```sh
docker compose ps                     # STATUS should show "healthy"
curl http://localhost:3000/health     # {"status":"ok"}
docker compose logs -f odp-mcp
```

To stop it, run `docker compose down`. After changing the source code, run `docker compose up -d --build` again.

### Prebuilt image

Every push to `main` publishes a multi-arch image (`linux/amd64`, `linux/arm64`) to the GitHub Container Registry, tagged `latest` and `sha-<short commit>`. To run it without cloning the repo:

```sh
docker run -d --name odp-mcp --restart unless-stopped -p 127.0.0.1:3000:3000 ghcr.io/jacobpretorius/opti.odp.mcp:latest
```

### Optional operator settings

No settings are required. `ODP_MCP_AUTH_TOKEN` is a secret, so put it in a `.env` file next to `docker-compose.yml` (the file is gitignored and Compose reads it automatically), as `ODP_MCP_AUTH_TOKEN=<long random string>`. Set the others under `environment:` in `docker-compose.yml`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ODP_MCP_AUTH_TOKEN` | not set | If set (at least 16 characters), clients must also send `Authorization: Bearer <token>`. Use it when anyone other than you can reach the endpoint. |
| `ODP_MCP_ALLOW_MUTATIONS` | `false` | Allow GraphQL mutations. |
| `ODP_MCP_ENABLE_EXPORTS` | `true` | Show the export-job start tools. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address inside the container. |
| `ODP_MCP_UPSTREAM_OVERRIDE` | not set | Testing only: send every ODP call to this URL instead of the regional ODP host. |

## Connect Claude Desktop

Claude Desktop cannot send custom headers to an HTTP MCP server on its own:

- `claude_desktop_config.json` only launches local commands.
- **Settings > Connectors > Add custom connector** connects from Anthropic's cloud, so it cannot reach `localhost`. It also supports only OAuth, not custom headers. See [custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

The standard workaround is [`mcp-remote`](https://www.npmjs.com/package/mcp-remote). It is a small local bridge that Claude Desktop launches. It forwards MCP traffic to the server's HTTP endpoint and adds your headers. It requires Node.js on the machine running Claude Desktop, and it is fetched automatically by `npx`.

1. Find the full path to `npx` (Claude Desktop does not load your shell's `PATH`):

   ```sh
   which npx
   ```

2. Open **Claude Desktop > Settings > Developer > Edit Config**. This opens `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or `%APPDATA%\Claude\claude_desktop_config.json` on Windows.

3. Add the server. Replace the `npx` path, the API key and the region:

   ```json
   {
     "mcpServers": {
       "odp": {
         "command": "npx",
         "args": [
           "-y", "mcp-remote@latest",
           "http://localhost:3000/mcp",
           "--transport", "http-only",
           "--header", "X-ODP-API-Key:${ODP_API_KEY}",
           "--header", "X-ODP-Region:${ODP_REGION}"
         ],
         "env": {
           "ODP_API_KEY": "your-odp-private-api-key",
           "ODP_REGION": "us"
         }
       }
     }
   }
   ```

4. Quit and restart Claude Desktop. The `odp` server and its tools then appear in the chat box's tools menu.

Notes:

- **Where the values go.** `mcp-remote` fills in `${ODP_API_KEY}` and `${ODP_REGION}` from `env`. The key lives only in this file. Keep the header arguments free of spaces (`Name:${VAR}`), because some clients mishandle spaces inside `args`.
- **Several accounts:** add one entry per account, for example `"odp-us-brand"` and `"odp-eu-brand"`, each with its own `env`.
- **Server token:** if the server has `ODP_MCP_AUTH_TOKEN` set, add `"--header", "Authorization:${ODP_MCP_AUTH}"` to `args` and `"ODP_MCP_AUTH": "Bearer <token>"` to `env`.
- **Remote server:** if the server is not on `localhost` and is served over plain HTTP, `mcp-remote` also needs `--allow-http`. Only do this on a trusted network; use HTTPS otherwise.
- **Keeping the key out of the process list:** `mcp-remote` can read headers from a file instead, using `"--header-file", "/path/to/odp-headers.txt"`. The file has one `Name: value` per line.
- **Troubleshooting:** Claude Desktop's log for the server is at `~/Library/Logs/Claude/mcp-server-odp.log` on macOS. The server's own log is `docker compose logs odp-mcp`. If you use nvm, the `npx` path changes when you switch Node versions.

## Connect Claude Code and other HTTP clients

Clients that support HTTP MCP servers with custom headers can connect directly, without a bridge:

```sh
claude mcp add --transport http odp http://localhost:3000/mcp \
  --header "X-ODP-API-Key: your-odp-private-api-key" \
  --header "X-ODP-Region: us"
```

Raw HTTP, for example to test from a script:

```sh
curl -s http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  -H 'x-odp-api-key: your-odp-private-api-key' \
  -H 'x-odp-region: us' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"odp_list_lists","arguments":{}}}'
```

## Example prompts

- "Show me the ODP GraphQL schema and describe the Customer type."
- "Find the customer jane@example.com, with their last orders and whether they're subscribed to the newsletter list."
- "List customers whose email matches 'jacob*'."
- "Which real-time segments exist, and is vuid 7bfa… in `active_visitors`?"
- "Export all customers with an email and CCPA opt-out status, then check when the export is done."

Useful GraphQL patterns:

```graphql
# Filtering
{ customers(filter: "email =~ 'jacob*'") { edges { node { email first_name } } } }

# Facets: the top 10 values of a text field
{ customers { facets { first_name { name count } } } }

# List subscription
{ customer(email: "a@b.com") { list_member(list_id: "newsletter") { subscribed } } }

# Real-time segment membership
{ customer(vuid: "…") { audiences(subset: ["active_visitors"]) { edges { node { name } } } } }
```

## Security notes

- A private API key can read all customer data (PII) in its account. Every request carries one, so any traffic that leaves `localhost` must use HTTPS. Put a TLS reverse proxy in front of the container.
- The server holds keys only in memory, for the duration of a request. It never writes or logs them. It caches introspected schemas per account under a SHA-256 hash of the key, never the key itself.
- Without `ODP_MCP_AUTH_TOKEN`, anyone who can reach the port can use the server as a relay to the ODP API. They still need a valid ODP key to get any data. Compose publishes the port on `127.0.0.1` only. Set a token before exposing it more widely.
- Error messages leave out query strings, because they can contain customer identifiers. Tool results contain whatever ODP returns.

## Development

The build and runtime both happen inside Docker, so a local Node install is not needed. The multi-stage `Dockerfile` compiles the TypeScript and ships only `dist/` and the production dependencies. It runs as the non-root `node` user.

```
src/
  index.ts            HTTP server: header parsing, per-request MCP server
  settings.ts         optional env settings, region hosts, fixed limits
  odp-client.ts       fetch wrapper: auth header, timeouts, retries, errors
  context.ts          per-request tool context, result and error formatting
  graphql-schema.ts   introspection cache, read-only guard, schema helpers
  tools/graphql.ts    GraphQL tools
  tools/rest.ts       REST GET tools (declarative table)
  tools/exports.ts    export job tools
```

To add a REST read endpoint, add an entry to `GET_TOOLS` in `src/tools/rest.ts`.

To test without a real ODP account, run a mock ODP API on the host and point the container at it with `ODP_MCP_UPSTREAM_OVERRIDE=http://host.docker.internal:<port>`.

## License

MIT. See [LICENSE](LICENSE).
