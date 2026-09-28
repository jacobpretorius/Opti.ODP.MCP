import {
  buildClientSchema,
  getIntrospectionQuery,
  getNamedType,
  isEnumType,
  isNonNullType,
  isObjectType,
  isScalarType,
  Kind,
  OperationTypeNode,
  parse,
  type GraphQLField,
  type GraphQLObjectType,
  type GraphQLSchema,
  type IntrospectionQuery,
} from "graphql";
import { createHash } from "node:crypto";
import { UserError } from "./context.js";
import type { OdpClient } from "./odp-client.js";
import { LIMITS } from "./settings.js";

interface CacheEntry {
  schema: GraphQLSchema;
  fetchedAt: number;
}

/**
 * Introspected schemas shared across requests, one per ODP account. Entries are keyed by a hash of
 * host + API key so raw keys are never held as map keys; the map is bounded and evicts least recently used.
 */
export class SchemaCache {
  private readonly entries = new Map<string, CacheEntry>();

  async get(client: OdpClient, refresh = false): Promise<GraphQLSchema> {
    const { host, apiKey } = client.connection;
    const key = createHash("sha256").update(`${host}\n${apiKey}`).digest("hex");
    const cached = this.entries.get(key);
    if (cached && !refresh && Date.now() - cached.fetchedAt < LIMITS.schemaCacheTtlMs) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.schema;
    }

    const res = await client.graphql<IntrospectionQuery>(getIntrospectionQuery());
    if (!res.data) {
      throw new Error(`GraphQL introspection failed: ${JSON.stringify(res.errors ?? res, null, 2)}`);
    }
    const schema = buildClientSchema(res.data, { assumeValid: true });
    this.entries.delete(key);
    this.entries.set(key, { schema, fetchedAt: Date.now() });
    if (this.entries.size > LIMITS.schemaCacheMaxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    return schema;
  }
}

export function queryRoot(schema: GraphQLSchema): GraphQLObjectType {
  const root = schema.getQueryType();
  if (!root) throw new Error("ODP GraphQL schema has no Query type");
  return root;
}

export function rootField(schema: GraphQLSchema, name: string): GraphQLField<unknown, unknown> {
  const field = queryRoot(schema).getFields()[name];
  if (!field) {
    throw new UserError(
      `"${name}" is not a root query field. Available: ${Object.keys(queryRoot(schema).getFields()).sort().join(", ")}`,
    );
  }
  return field;
}

/** Names of the fields on `type` that resolve to scalars/enums and need no required arguments. */
export function scalarFieldNames(type: GraphQLObjectType): string[] {
  return Object.values(type.getFields())
    .filter((f) => {
      const named = getNamedType(f.type);
      return (isScalarType(named) || isEnumType(named)) && !f.args.some((a) => isNonNullType(a.type));
    })
    .map((f) => f.name);
}

/** One-line SDL-style signature, e.g. `customer(email: String, vuid: String): Customer`. */
export function fieldSignature(field: GraphQLField<unknown, unknown>): string {
  const args = field.args.length ? `(${field.args.map((a) => `${a.name}: ${a.type}`).join(", ")})` : "";
  return `${field.name}${args}: ${field.type}`;
}

/** Rejects documents containing mutations/subscriptions unless allowed. Throws UserError on syntax errors. */
export function assertAllowedOperation(query: string, allowMutations: boolean): void {
  let doc;
  try {
    doc = parse(query);
  } catch (err) {
    throw new UserError(`GraphQL syntax error: ${(err as Error).message}`);
  }
  for (const def of doc.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) continue;
    if (def.operation === OperationTypeNode.SUBSCRIPTION) {
      throw new UserError("GraphQL subscriptions are not supported by this server.");
    }
    if (def.operation === OperationTypeNode.MUTATION && !allowMutations) {
      throw new UserError(
        "GraphQL mutations are disabled. This server is read-only; the server operator can enable them with ODP_MCP_ALLOW_MUTATIONS=true.",
      );
    }
  }
}

/** Resolves the node type of a Relay-style connection type (`edges { node }`), if it is one. */
export function connectionNodeType(type: GraphQLObjectType): GraphQLObjectType | undefined {
  const edges = type.getFields().edges;
  if (!edges) return undefined;
  const edgeType = getNamedType(edges.type);
  if (!isObjectType(edgeType)) return undefined;
  const node = edgeType.getFields().node;
  const nodeType = node && getNamedType(node.type);
  return nodeType && isObjectType(nodeType) ? nodeType : undefined;
}
