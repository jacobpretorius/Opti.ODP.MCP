import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  printType,
  type GraphQLNamedType,
} from "graphql";
import * as z from "zod";
import { READ_ONLY, safe, UserError, type ToolContext } from "../context.js";
import { LIMITS } from "../settings.js";
import {
  assertAllowedOperation,
  connectionNodeType,
  fieldSignature,
  queryRoot,
  rootField,
  scalarFieldNames,
  type SchemaCache,
} from "../graphql-schema.js";

const IDENT = /^[_A-Za-z][_0-9A-Za-z]*$/;

const fieldsArg = z
  .string()
  .optional()
  .describe(
    "GraphQL selection set for each record, without the outer braces, e.g. `email first_name last_name` or " +
      "`email list_member(list_id: \"newsletter\") { subscribed }`. Defaults to all scalar fields of the type.",
  );

export function registerGraphqlTools(server: McpServer, ctx: ToolContext, schemas: SchemaCache) {
  const allowMutations = ctx.settings.ODP_MCP_ALLOW_MUTATIONS;
  const { defaultPageSize } = LIMITS;

  async function execute(query: string, variables?: Record<string, unknown>, operationName?: string) {
    assertAllowedOperation(query, allowMutations);
    return ctx.client.graphql(query, variables, operationName);
  }

  server.registerTool(
    "odp_graphql_query",
    {
      title: "Run ODP GraphQL query",
      description:
        "Run a GraphQL query against the ODP GraphQL API (/v3/graphql) using the caller's ODP private key. " +
        "Queries any dimension in the account: customers, events, orders, products, lists, list_member, observations, insights, " +
        "custom objects and real-time audiences. Use odp_graphql_schema_overview and odp_graphql_describe_type first to discover " +
        "fields and arguments. Filter syntax example: `customers(filter: \"email =~ 'jane*'\")`. Max page size is 1000; " +
        "for more rows use the export tools." +
        (allowMutations ? "" : " Mutations are disabled."),
      inputSchema: {
        query: z.string().min(1).describe("GraphQL document."),
        variables: z.record(z.string(), z.unknown()).optional().describe("GraphQL variables."),
        operationName: z.string().optional().describe("Operation to run when the document contains several."),
      },
      annotations: { ...READ_ONLY, readOnlyHint: !allowMutations },
    },
    safe(async ({ query, variables, operationName }) =>
      ctx.jsonResult(await execute(query, variables, operationName)),
    ),
  );

  server.registerTool(
    "odp_graphql_schema_overview",
    {
      title: "ODP GraphQL schema overview",
      description:
        "List the root query fields (entry points with their arguments) and the object types of the account's ODP GraphQL schema. " +
        "Custom objects and fields appear here too. Start here before writing a query.",
      inputSchema: {
        refresh: z.boolean().optional().describe("Bypass the cached schema and re-run introspection."),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ refresh }) => {
      const schema = await schemas.get(ctx.client, refresh);
      const rootFields = Object.values(queryRoot(schema).getFields())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f) => (f.description ? `${fieldSignature(f)}  # ${oneLine(f.description)}` : fieldSignature(f)));
      const types = Object.values(schema.getTypeMap())
        .filter((t) => !t.name.startsWith("__"))
        .reduce<Record<string, string[]>>((acc, t) => {
          const kind = kindOf(t);
          (acc[kind] ??= []).push(t.name);
          return acc;
        }, {});
      for (const names of Object.values(types)) names.sort();
      return {
        content: [
          {
            type: "text",
            text: `# Root query fields\n${rootFields.join("\n")}\n\n# Types by kind\n${Object.entries(types)
              .map(([kind, names]) => `## ${kind} (${names.length})\n${names.join(", ")}`)
              .join("\n\n")}`,
          },
        ],
      };
    }),
  );

  server.registerTool(
    "odp_graphql_describe_type",
    {
      title: "Describe ODP GraphQL type",
      description:
        "Show the SDL definition (fields, arguments, descriptions, enum values) of one or more types in the ODP GraphQL schema, " +
        "e.g. Customer, Event, Order, Product or a custom object type.",
      inputSchema: {
        names: z.array(z.string().min(1)).min(1).max(20).describe("Type names, case-sensitive."),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ names }) => {
      const schema = await schemas.get(ctx.client);
      const typeMap = schema.getTypeMap();
      const blocks = names.map((name) => {
        const type = schema.getType(name);
        if (type) return printType(type);
        const lower = name.toLowerCase();
        const similar = Object.keys(typeMap).filter((t) => !t.startsWith("__") && t.toLowerCase().includes(lower));
        return `# Type "${name}" not found.${similar.length ? ` Similar: ${similar.slice(0, 20).join(", ")}` : ""}`;
      });
      return { content: [{ type: "text", text: blocks.join("\n\n") }] };
    }),
  );

  server.registerTool(
    "odp_graphql_get_customer",
    {
      title: "Get ODP customer (GraphQL)",
      description:
        "Fetch one customer by any identifier the schema supports (e.g. email, vuid, customer_id, zaius_id) via GraphQL. " +
        "Use `fields` to join related data such as events, orders, list_member or audiences in the same call.",
      inputSchema: {
        identifier_field: z.string().regex(IDENT).describe("Identifier argument name, e.g. `email`, `vuid`, `zaius_id`."),
        identifier_value: z.string().min(1).describe("Identifier value."),
        fields: fieldsArg,
      },
      annotations: READ_ONLY,
    },
    safe(async ({ identifier_field, identifier_value, fields }) => {
      const schema = await schemas.get(ctx.client);
      const field = rootField(schema, "customer");
      const arg = field.args.find((a) => a.name === identifier_field);
      if (!arg) {
        throw new UserError(
          `customer() does not accept "${identifier_field}". Supported identifiers: ${field.args.map((a) => a.name).join(", ")}`,
        );
      }
      const selection = fields ?? defaultSelection(getNamedType(field.type));
      const query = `query GetCustomer($id: ${arg.type}) {\n  customer(${identifier_field}: $id) {\n    ${selection}\n  }\n}`;
      return ctx.jsonResult(await execute(query, { id: identifier_value }));
    }),
  );

  server.registerTool(
    "odp_graphql_list",
    {
      title: "List ODP records (GraphQL)",
      description:
        "Page through records of any list-style GraphQL dimension (customers, events, orders, products, custom objects, ...) " +
        "with an optional filter expression. Returns records plus a cursor for the next page. " +
        "Only arguments the dimension supports are sent; the error lists the supported ones.",
      inputSchema: {
        dimension: z.string().regex(IDENT).default("customers").describe("Root query field, e.g. `customers`, `orders`, `events`."),
        filter: z
          .string()
          .optional()
          .describe("ODP filter expression, e.g. `first_name = 'Jacob'` or `email =~ 'jacob*'`."),
        first: z.number().int().min(1).max(1000).optional().describe(`Page size (default ${defaultPageSize}, max 1000).`),
        after: z.string().optional().describe("Cursor from the previous page (`endCursor` or last edge `cursor`)."),
        fields: fieldsArg,
        extra_args: z
          .record(z.string().regex(IDENT), z.unknown())
          .optional()
          .describe("Any other arguments the dimension accepts (see odp_graphql_schema_overview), passed as variables."),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ dimension, filter, first, after, fields, extra_args }) => {
      const schema = await schemas.get(ctx.client);
      const field = rootField(schema, dimension);
      const connection = getNamedType(field.type);
      const nodeType = isObjectType(connection) ? connectionNodeType(connection) : undefined;
      if (!isObjectType(connection) || !nodeType) {
        throw new UserError(`"${dimension}" is not a connection (edges/node) field; use odp_graphql_query instead.`);
      }

      const wanted: Record<string, unknown> = { ...extra_args, filter, after };
      if (field.args.some((a) => a.name === "first")) wanted.first = first ?? defaultPageSize;
      else if (first !== undefined) wanted.first = first;

      const argDefs = field.args.filter((a) => wanted[a.name] !== undefined);
      const unsupported = Object.keys(wanted).filter((k) => wanted[k] !== undefined && !field.args.some((a) => a.name === k));
      if (unsupported.length) {
        throw new UserError(
          `${dimension}() does not accept: ${unsupported.join(", ")}. Supported: ${field.args.map((a) => `${a.name}: ${a.type}`).join(", ")}`,
        );
      }

      const pageInfo = connection.getFields().pageInfo;
      const pageInfoType = pageInfo && getNamedType(pageInfo.type);
      const hasPageInfo =
        isObjectType(pageInfoType) && ["hasNextPage", "endCursor"].every((f) => f in pageInfoType.getFields());
      const vars = argDefs.map((a) => `$${a.name}: ${a.type}`).join(", ");
      const args = argDefs.map((a) => `${a.name}: $${a.name}`).join(", ");
      const query =
        `query List${vars ? `(${vars})` : ""} {\n  ${dimension}${args ? `(${args})` : ""} {\n` +
        `    edges { cursor node { ${fields ?? defaultSelection(nodeType)} } }\n` +
        (hasPageInfo ? "    pageInfo { hasNextPage endCursor }\n" : "") +
        "  }\n}";
      const variables = Object.fromEntries(argDefs.map((a) => [a.name, wanted[a.name]]));
      return ctx.jsonResult(await execute(query, variables));
    }),
  );
}

function defaultSelection(type: ReturnType<typeof getNamedType>): string {
  if (!isObjectType(type)) throw new UserError(`${type} has no fields to select; pass \`fields\` explicitly.`);
  const names = scalarFieldNames(type);
  if (!names.length) throw new UserError(`${type.name} has no scalar fields; pass \`fields\` explicitly.`);
  return names.join(" ");
}

function kindOf(t: GraphQLNamedType): string {
  if (isObjectType(t)) return "Object";
  if (isInputObjectType(t)) return "InputObject";
  if (isEnumType(t)) return "Enum";
  if (isScalarType(t)) return "Scalar";
  if (isInterfaceType(t)) return "Interface";
  return "Union";
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
