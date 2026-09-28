import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { READ_ONLY, safe, type ToolContext } from "../context.js";
import type { QueryValue } from "../odp-client.js";

type Shape = Record<string, z.ZodType>;

interface GetTool<S extends Shape> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** Builds the request path (relative to /v3) and query string from the tool arguments. */
  request: (args: z.infer<z.ZodObject<S>>) => { path: string; query?: Record<string, QueryValue> };
}

const seg = (s: string) => encodeURIComponent(s);

const identifiers = z
  .record(z.string().regex(/^[A-Za-z0-9_]+$/), z.string().min(1))
  .refine((r) => Object.keys(r).length > 0, "provide at least one identifier")
  .describe('Customer identifier(s) as name/value, e.g. {"email": "jane@example.com"} or {"vuid": "..."}.');

const identifierField = z.string().min(1).describe("Identifier field name, e.g. `email`.");
const identifierValue = z.string().min(1).describe("Identifier value, e.g. an email address.");
const objectName = z.string().min(1).describe("Object name, e.g. `customers`, `orders`, `products` or a custom object.");

function defineGetTool<S extends Shape>(tool: GetTool<S>) {
  return tool;
}

const GET_TOOLS = [
  defineGetTool({
    name: "odp_get_customer_profile",
    title: "Get customer profile (REST)",
    description: "GET /v3/profiles - attributes and identifiers of a customer, looked up by a single identifier.",
    input: { identifiers },
    request: ({ identifiers }) => ({ path: "/profiles", query: identifiers }),
  }),
  defineGetTool({
    name: "odp_get_consent",
    title: "Get marketing consent",
    description: "GET /v3/consent/{identifier_field} - marketing consent status of a messaging identifier.",
    input: { identifier_field: identifierField, id: identifierValue },
    request: ({ identifier_field, id }) => ({ path: `/consent/${seg(identifier_field)}`, query: { id } }),
  }),
  defineGetTool({
    name: "odp_get_reachability",
    title: "Get reachability",
    description: "GET /v3/reachability/{identifier_field} - whether a messaging identifier is reachable (bounces, etc.).",
    input: { identifier_field: identifierField, id: identifierValue },
    request: ({ identifier_field, id }) => ({ path: `/reachability/${seg(identifier_field)}`, query: { id } }),
  }),
  defineGetTool({
    name: "odp_get_identifier_metadata",
    title: "Get identifier metadata",
    description: "GET /v3/identifiers/{field_name} - metadata stored for an identifier value.",
    input: { field_name: identifierField, id: identifierValue.optional() },
    request: ({ field_name, id }) => ({ path: `/identifiers/${seg(field_name)}`, query: { id } }),
  }),
  defineGetTool({
    name: "odp_list_lists",
    title: "List subscription lists",
    description: "GET /v3/lists - all subscription (messaging) lists in the account.",
    input: {},
    request: () => ({ path: "/lists" }),
  }),
  defineGetTool({
    name: "odp_get_list_subscriptions",
    title: "Get list subscriptions",
    description: "GET /v3/lists/subscriptions - opt-in status and list subscriptions of a customer identifier.",
    input: { identifiers },
    request: ({ identifiers }) => ({ path: "/lists/subscriptions", query: identifiers }),
  }),
  defineGetTool({
    name: "odp_list_objects",
    title: "List schema objects",
    description: "GET /v3/schema/objects - every object (standard and custom) in the account's schema.",
    input: {},
    request: () => ({ path: "/schema/objects" }),
  }),
  defineGetTool({
    name: "odp_get_object",
    title: "Get schema object",
    description: "GET /v3/schema/objects/{object_name} - one object's schema including fields and relations.",
    input: { object_name: objectName },
    request: ({ object_name }) => ({ path: `/schema/objects/${seg(object_name)}` }),
  }),
  defineGetTool({
    name: "odp_list_fields",
    title: "List object fields",
    description: "GET /v3/schema/objects/{object_name}/fields - all fields of an object.",
    input: { object_name: objectName },
    request: ({ object_name }) => ({ path: `/schema/objects/${seg(object_name)}/fields` }),
  }),
  defineGetTool({
    name: "odp_get_field",
    title: "Get object field",
    description: "GET /v3/schema/objects/{object_name}/fields/{field_name} - one field's definition.",
    input: { object_name: objectName, field_name: z.string().min(1).describe("Field name.") },
    request: ({ object_name, field_name }) => ({ path: `/schema/objects/${seg(object_name)}/fields/${seg(field_name)}` }),
  }),
  defineGetTool({
    name: "odp_list_relations",
    title: "List object relations",
    description: "GET /v3/schema/objects/{object_name}/relations - relationships from an object to other objects.",
    input: { object_name: objectName },
    request: ({ object_name }) => ({ path: `/schema/objects/${seg(object_name)}/relations` }),
  }),
  defineGetTool({
    name: "odp_get_relation",
    title: "Get object relation",
    description: "GET /v3/schema/objects/{object_name}/relations/{relation_name} - one relationship's definition.",
    input: { object_name: objectName, relation_name: z.string().min(1).describe("Relation name.") },
    request: ({ object_name, relation_name }) => ({
      path: `/schema/objects/${seg(object_name)}/relations/${seg(relation_name)}`,
    }),
  }),
  defineGetTool({
    name: "odp_list_segments",
    title: "List real-time segments",
    description:
      "GET /v3/segments - IDs of all real-time segments (audiences). Query membership with odp_graphql_query: " +
      '`customer(email: "...") { audiences(subset: ["segment_id"]) { edges { node { name } } } }`.',
    input: {},
    request: () => ({ path: "/segments" }),
  }),
  defineGetTool({
    name: "odp_get_segment",
    title: "Get real-time segment",
    description: "GET /v3/segments/{segment_id} - definition, description and revision of a real-time segment (not its members).",
    input: { segment_id: z.string().regex(/^[A-Za-z0-9_]+$/).describe("Segment API name.") },
    request: ({ segment_id }) => ({ path: `/segments/${seg(segment_id)}` }),
  }),
  defineGetTool({
    name: "odp_get_recommended_products",
    title: "Get recommended products",
    description:
      "GET /v3/recommendations/products - personal (for a customer) or contextual (for product IDs) product recommendations. " +
      "With neither, returns 7-day best sellers.",
    input: {
      identifiers: z
        .record(z.string().regex(/^[A-Za-z0-9_]+$/), z.string().min(1))
        .optional()
        .describe('Customer identifier, e.g. {"email": "..."}; accepted: vuid, email, zaius_alias_*, customer_id.'),
      product_ids: z.array(z.string().min(1)).optional().describe("Product IDs for contextual recommendations."),
      type: z.enum(["personal", "contextual"]).optional(),
      criteria: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Product filter, e.g. {"expression": {"operator": "AND", "predicates": [{"field": "_on_sale", "datatype": "boolean", "value": "true", "operator": "="}]}}.',
        ),
      sort_by: z.string().optional().describe("Product field to sort the results by."),
      order: z.enum(["asc", "desc"]).optional(),
      limit: z.number().int().min(1).max(100).optional().describe("Number of products (1-100, default 10)."),
    },
    request: ({ identifiers, product_ids, type, criteria, sort_by, order, limit }) => ({
      path: "/recommendations/products",
      query: {
        ...identifiers,
        product_ids: product_ids?.join(","),
        type,
        criteria: criteria && JSON.stringify(criteria),
        sort_by,
        order,
        limit,
      },
    }),
  }),
  defineGetTool({
    name: "odp_get_compliance_request_status",
    title: "Get compliance request status",
    description: "GET /v3/compliance/{regulation}/status/{request_id} - status of a GDPR, CCPA or LGPD request.",
    input: {
      regulation: z.enum(["gdpr", "ccpa", "lgpd"]),
      request_id: z.string().min(1).describe("Request ID returned when the compliance request was made."),
    },
    request: ({ regulation, request_id }) => ({ path: `/compliance/${regulation}/status/${seg(request_id)}` }),
  }),
];

export function registerRestTools(server: McpServer, ctx: ToolContext) {
  for (const tool of GET_TOOLS as GetTool<Shape>[]) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: READ_ONLY,
      },
      safe(async (args: Record<string, unknown>) => ctx.jsonResult(await ctx.client.rest(tool.request(args)))),
    );
  }
}
