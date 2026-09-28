import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { READ_ONLY, safe, UserError, type ToolContext } from "../context.js";

const format = z.enum(["csv", "parquet"]).default("csv").describe("Export file format.");
const delimiter = z.enum(["comma", "tab", "pipe"]).default("comma").describe("CSV delimiter (ignored for parquet).");
const exportJobId = z.string().min(1).describe("Export job ID (the top-level `id` returned when the job was started).");

/** A job start creates files in ODP's S3 bucket but never changes account data. */
const START_JOB = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

export function registerExportTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "odp_get_export_status",
    {
      title: "Get data export job status",
      description:
        "GET /v3/exports/{id} - state of a data export job (pending, running, completed, completed_with_errors), row count and S3 path.",
      inputSchema: { export_id: exportJobId },
      annotations: READ_ONLY,
    },
    safe(async ({ export_id }) =>
      ctx.jsonResult(await ctx.client.rest({ path: `/exports/${encodeURIComponent(export_id)}` })),
    ),
  );

  server.registerTool(
    "odp_get_segment_export_status",
    {
      title: "Get segment export job status",
      description:
        "GET /v3/export-segment-members/{id} - state of a segment member export job, including presigned download URLs (valid 1 hour) when complete.",
      inputSchema: { export_id: exportJobId },
      annotations: READ_ONLY,
    },
    safe(async ({ export_id }) =>
      ctx.jsonResult(await ctx.client.rest({ path: `/export-segment-members/${encodeURIComponent(export_id)}` })),
    ),
  );

  if (!ctx.settings.ODP_MCP_ENABLE_EXPORTS) return;

  server.registerTool(
    "odp_start_data_export",
    {
      title: "Start data export job",
      description:
        "POST /v3/exports - start an asynchronous export of ODP data to ODP's S3 bucket. Use for bulk reads (> 1000 records). " +
        "Pass `objects` for full exports of whole objects, or `select` for a filtered export of one object. " +
        "Poll odp_get_export_status with the returned `id` until state is `completed`.",
      inputSchema: {
        format,
        delimiter,
        objects: z.array(z.string().min(1)).min(1).optional().describe('Objects to export in full, e.g. ["customers", "products"].'),
        select: z
          .object({
            object: z.string().min(1).describe("Target object, e.g. `customers` or `events`."),
            fields: z
              .array(z.string().min(1))
              .min(1)
              .describe('Fields to export; related fields use dot paths (e.g. "product.name"). ["*"] exports every field of the object.'),
            filter: z
              .record(z.string(), z.unknown())
              .optional()
              .describe(
                'Filter clause, e.g. {"field": "email", "operator": "!=", "value": null}, or nested {"and": [...]} / {"or": [...]} (lowercase).',
              ),
            sorts: z
              .array(z.object({ field: z.string(), order: z.enum(["asc", "desc"]) }))
              .optional()
              .describe("Sort order applied within each export file."),
          })
          .optional(),
      },
      annotations: START_JOB,
    },
    safe(async ({ format, delimiter, objects, select }) => {
      if (!objects === !select) throw new UserError("Provide exactly one of `objects` or `select`.");
      return ctx.jsonResult(
        await ctx.client.rest({ method: "POST", path: "/exports", body: { format, delimiter, objects, select } }),
      );
    }),
  );

  server.registerTool(
    "odp_start_segment_export",
    {
      title: "Start segment member export job",
      description:
        "POST /v3/export-segment-members - export the members of real-time segments (use segment API names, not display names). " +
        "Poll odp_get_segment_export_status with the returned `id` for presigned download URLs.",
      inputSchema: {
        format,
        delimiter,
        segments: z.array(z.string().min(1)).min(1).describe("Real-time segment API names."),
        fields: z
          .array(z.string().min(1))
          .min(1)
          .default(["customer.zaius_id", "customer.email", "valid_time", "qualifications"])
          .describe("Fields to export: customer.<field>, valid_time, qualifications."),
        maxDelay: z.string().optional().describe("ISO-8601 duration of acceptable data staleness, e.g. `PT1H`."),
      },
      annotations: START_JOB,
    },
    safe(async ({ format, delimiter, segments, fields, maxDelay }) =>
      ctx.jsonResult(
        await ctx.client.rest({
          method: "POST",
          path: "/export-segment-members",
          body: { format, delimiter, select: { segments, fields, maxDelay } },
        }),
      ),
    ),
  );
}
