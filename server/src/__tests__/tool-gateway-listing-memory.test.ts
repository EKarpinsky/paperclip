import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  principalPermissionGrants,
  projects,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import type { ToolAccessDecisionInput } from "@paperclipai/shared";
import {
  createToolAccessDecisionCache,
  toolAccessPolicyService,
} from "../services/tool-access-policy.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

// Real run snapshots carry the task text several times over; a policy check
// must read only the context ids out of it.
const LARGE_TASK_TEXT = "Task description. ".repeat(12_000);

/** A second handle on the same connection pool that records every statement. */
function recordingDb(db: Db) {
  const statements: string[] = [];
  const recorded = drizzle(db.$client, {
    schema: db._.fullSchema,
    logger: {
      logQuery: (query: string) => {
        statements.push(query);
      },
    },
  }) as unknown as Db;
  return { db: recorded, statements };
}

async function createListingFixture(
  db: Db,
  toolCount: number,
  options: { broadBindings?: boolean } = {},
) {
  const company = await db.insert(companies).values({
    name: `Listing ${randomUUID()}`,
    issuePrefix: `LM${randomUUID().slice(0, 6).toUpperCase()}`,
  }).returning().then((rows) => rows[0]!);
  const agent = await db.insert(agents).values({
    companyId: company.id,
    name: `Listing Agent ${randomUUID()}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  }).returning().then((rows) => rows[0]!);
  const project = await db.insert(projects).values({
    companyId: company.id,
    name: `Listing Project ${randomUUID()}`,
  }).returning().then((rows) => rows[0]!);
  const issue = await db.insert(issues).values({
    companyId: company.id,
    projectId: project.id,
    title: "Listing work",
    status: "in_progress",
    assigneeAgentId: agent.id,
  }).returning().then((rows) => rows[0]!);
  const run = await db.insert(heartbeatRuns).values({
    companyId: company.id,
    agentId: agent.id,
    invocationSource: "assignment",
    status: "running",
    contextSnapshot: { issueId: issue.id, projectId: project.id, taskMarkdown: LARGE_TASK_TEXT },
    resultJson: { summary: LARGE_TASK_TEXT },
  }).returning().then((rows) => rows[0]!);
  const application = await db.insert(toolApplications).values({
    companyId: company.id,
    applicationKey: `listing-${randomUUID().slice(0, 8)}`,
    name: `Listing MCP ${randomUUID()}`,
    type: "mcp_http",
    status: "active",
  }).returning().then((rows) => rows[0]!);
  const connection = await db.insert(toolConnections).values({
    companyId: company.id,
    applicationId: application.id,
    name: "Listing connection",
    uid: `test/${randomUUID()}`,
    transport: "mcp_remote",
    status: "active",
    enabled: true,
    healthStatus: "ok",
    credentialPolicy: "shared",
    config: { url: "https://8.8.8.8/mcp", notes: "connection config ".repeat(500) },
  }).returning().then((rows) => rows[0]!);
  const entries = await db.insert(toolCatalogEntries).values(
    Array.from({ length: toolCount }, (_, index) => ({
      companyId: company.id,
      applicationId: application.id,
      connectionId: connection.id,
      entryKind: "tool" as const,
      name: `tool_${String(index).padStart(4, "0")}`,
      toolName: `tool_${String(index).padStart(4, "0")}`,
      description: `Fixture tool ${index}`,
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Query text. ".repeat(40) } },
      },
      riskLevel: index % 3 === 0 ? "write" as const : "read" as const,
      isReadOnly: index % 3 !== 0,
      isWrite: index % 3 === 0,
      status: "active" as const,
      versionHash: randomUUID(),
      schemaHash: randomUUID(),
    })),
  ).returning();

  // The gateway profile allows every tool except one excluded entry. The
  // company and agent bindings lose to the narrower gateway binding.
  const gatewayProfile = await db.insert(toolProfiles).values({
    companyId: company.id,
    profileKey: `gateway-${randomUUID()}`,
    name: `Gateway profile ${randomUUID()}`,
    defaultAction: "allow",
  }).returning().then((rows) => rows[0]!);
  await db.insert(toolProfileEntries).values({
    companyId: company.id,
    profileId: gatewayProfile.id,
    selectorType: "catalog_entry",
    catalogEntryId: entries[1]!.id,
    effect: "exclude",
  });
  const broadProfile = await db.insert(toolProfiles).values({
    companyId: company.id,
    profileKey: `broad-${randomUUID()}`,
    name: `Broad profile ${randomUUID()}`,
    defaultAction: "deny",
  }).returning().then((rows) => rows[0]!);
  if (options.broadBindings !== false) {
    await db.insert(toolProfileBindings).values([
      { companyId: company.id, profileId: broadProfile.id, targetType: "company", targetId: company.id },
      { companyId: company.id, profileId: broadProfile.id, targetType: "agent", targetId: agent.id },
    ]);
  }
  await db.insert(toolPolicies).values([
    {
      companyId: company.id,
      name: `Block one tool ${randomUUID()}`,
      policyType: "block",
      priority: 10,
      selectors: { catalogEntryId: entries[2]!.id },
    },
    {
      companyId: company.id,
      name: `Review writes ${randomUUID()}`,
      policyType: "require_approval",
      priority: 20,
      selectors: { riskLevel: "write" },
    },
  ]);
  // A grant for another connection: the listing reads it, but it allows nothing here.
  await db.insert(principalPermissionGrants).values({
    companyId: company.id,
    principalType: "agent",
    principalId: agent.id,
    permissionKey: "tools:use",
    scope: { connectionId: randomUUID() },
  });

  const setupGateway = createToolGatewayService(db);
  const namedGateway = await setupGateway.createNamedGateway({
    companyId: company.id,
    body: { name: `Listing gateway ${randomUUID().slice(0, 8)}`, profileId: gatewayProfile.id },
  });
  const token = await setupGateway.createNamedGatewayToken({
    companyId: company.id,
    gatewayId: namedGateway.id,
    body: {
      name: "Run token",
      subjectType: "heartbeat_run",
      subjectId: run.id,
      clientLabel: "codex",
      ownerNote: "",
    },
  });
  return { company, agent, project, issue, run, application, connection, entries, namedGateway, token };
}

describeEmbeddedPostgres("tool gateway listing memory", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-gateway-listing-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function measureNamedGatewayListing(fixture: Awaited<ReturnType<typeof createListingFixture>>) {
    const listing = {
      gatewayId: fixture.namedGateway.id,
      bearerToken: fixture.token.token,
    };
    // Warm module-level state so that both measurements take the same path.
    await createToolGatewayService(db).listToolsForNamedGateway(listing);
    const recorder = recordingDb(db);
    const tools = await createToolGatewayService(recorder.db).listToolsForNamedGateway(listing);
    return { tools, statements: recorder.statements };
  }

  it("keeps the query count of a named gateway listing constant from 50 to 500 catalog tools", async () => {
    const small = await createListingFixture(db, 50);
    const large = await createListingFixture(db, 500);

    const smallListing = await measureNamedGatewayListing(small);
    const largeListing = await measureNamedGatewayListing(large);

    const connectedTools = (listing: typeof smallListing, connectionId: string) =>
      listing.tools.filter((tool) => tool.connectionId === connectionId);
    // One tool is excluded by the gateway profile and one is blocked by policy.
    expect(connectedTools(smallListing, small.connection.id)).toHaveLength(48);
    expect(connectedTools(largeListing, large.connection.id)).toHaveLength(498);
    expect(connectedTools(smallListing, small.connection.id).map((tool) => tool.catalogEntryId))
      .not.toContain(small.entries[1]!.id);
    expect(connectedTools(smallListing, small.connection.id).map((tool) => tool.catalogEntryId))
      .not.toContain(small.entries[2]!.id);
    const approvalTool = connectedTools(smallListing, small.connection.id)
      .find((tool) => tool.catalogEntryId === small.entries[0]!.id);
    expect(approvalTool?.description).toMatch(/approval/i);

    expect(largeListing.statements.length).toBe(smallListing.statements.length);
    expect(largeListing.statements.length).toBeLessThan(100);
  });

  it("reads the catalog without repeating the connection row for each tool", async () => {
    const fixture = await createListingFixture(db, 20);
    const { statements } = await measureNamedGatewayListing(fixture);

    const catalogReads = statements.filter((statement) =>
      statement.includes('from "tool_catalog_entries"')
      && statement.includes('"tool_catalog_entries"."input_schema"'));
    expect(catalogReads.length).toBeGreaterThan(0);
    for (const statement of catalogReads) {
      expect(statement).not.toContain('"tool_connections"."config"');
    }
  });

  it("never selects the whole run snapshot or result when it decides access", async () => {
    // Without agent or company bindings, the project binding is the narrowest match.
    const fixture = await createListingFixture(db, 3, { broadBindings: false });
    const recorder = recordingDb(db);
    const policy = toolAccessPolicyService(recorder.db);
    const projectProfile = await db.insert(toolProfiles).values({
      companyId: fixture.company.id,
      profileKey: `project-${randomUUID()}`,
      name: `Project profile ${randomUUID()}`,
      defaultAction: "allow",
    }).returning().then((rows) => rows[0]!);
    await db.insert(toolProfileBindings).values({
      companyId: fixture.company.id,
      profileId: projectProfile.id,
      targetType: "project",
      targetId: fixture.project.id,
    });
    // The input names only the run. The project comes from the run snapshot,
    // so the project-bound profile allows the tool only if the policy check
    // reads the snapshot ids correctly.
    const input: ToolAccessDecisionInput = {
      companyId: fixture.company.id,
      actor: { actorType: "agent", actorId: fixture.agent.id, agentId: fixture.agent.id },
      runContext: { heartbeatRunId: fixture.run.id },
      request: {
        catalogEntryId: fixture.entries[1]!.id,
        connectionId: fixture.connection.id,
        toolName: "tool_0001",
        arguments: {},
      },
    };

    for (const cache of [undefined, createToolAccessDecisionCache()]) {
      recorder.statements.length = 0;
      const decision = await policy.decide(input, { cache });
      expect(decision).toMatchObject({
        allowed: true,
        reasonCode: "allow_profile",
        effectiveProfileIds: [projectProfile.id],
      });
      await policy.writeAudit(input, decision);
      const recorded = await policy.recordInvocation(input, decision);
      expect(recorded.invocation).toMatchObject({
        runId: fixture.run.id,
        issueId: fixture.issue.id,
      });

      expect(recorder.statements.some((statement) => statement.includes('"heartbeat_runs"'))).toBe(true);
      for (const statement of recorder.statements) {
        expect(statement).not.toMatch(/"context_snapshot"(?!\s*->)/);
        expect(statement).not.toContain("result_json");
        expect(statement).not.toContain('"input_schema"');
      }
    }
  });

  it("reads run context ids from the snapshot with the same rules as before", async () => {
    const fixture = await createListingFixture(db, 3, { broadBindings: false });
    const policy = toolAccessPolicyService(db);
    const otherIssue = await db.insert(issues).values({
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      title: "Other work",
      status: "in_progress",
    }).returning().then((rows) => rows[0]!);
    const projectProfile = await db.insert(toolProfiles).values({
      companyId: fixture.company.id,
      profileKey: `project-${randomUUID()}`,
      name: `Project profile ${randomUUID()}`,
      defaultAction: "allow",
    }).returning().then((rows) => rows[0]!);
    await db.insert(toolProfileBindings).values({
      companyId: fixture.company.id,
      profileId: projectProfile.id,
      targetType: "project",
      targetId: fixture.project.id,
    });
    const runWithSnapshot = (contextSnapshot: Record<string, unknown>) =>
      db.insert(heartbeatRuns).values({
        companyId: fixture.company.id,
        agentId: fixture.agent.id,
        invocationSource: "assignment",
        status: "running",
        contextSnapshot,
      }).returning().then((rows) => rows[0]!);
    const decideForRun = (runId: string, runContext: Partial<NonNullable<ToolAccessDecisionInput["runContext"]>> = {}) =>
      policy.decide({
        companyId: fixture.company.id,
        actor: { actorType: "agent", actorId: fixture.agent.id, agentId: fixture.agent.id },
        runContext: { heartbeatRunId: runId, ...runContext },
        request: {
          catalogEntryId: fixture.entries[1]!.id,
          connectionId: fixture.connection.id,
          toolName: "tool_0001",
          arguments: {},
        },
      });

    // The issue id alone resolves the project through the issue row.
    const issueOnly = await runWithSnapshot({ issueId: fixture.issue.id });
    expect(await decideForRun(issueOnly.id)).toMatchObject({ reasonCode: "allow_profile" });

    // Non-string and blank ids are ignored, as before.
    const malformed = await runWithSnapshot({ issueId: 42, projectId: "  ", routineId: { id: "x" } });
    expect(await decideForRun(malformed.id)).toMatchObject({ reasonCode: "deny_default" });
    expect(await decideForRun(malformed.id, { projectId: fixture.project.id }))
      .toMatchObject({ reasonCode: "allow_profile" });

    // A supplied context that disagrees with the stored snapshot is denied.
    expect(await decideForRun(issueOnly.id, { issueId: otherIssue.id }))
      .toMatchObject({ reasonCode: "deny_run_context_mismatch" });
  });

  it("returns the same decisions with a shared cache as without one", async () => {
    const fixture = await createListingFixture(db, 6);
    const other = await createListingFixture(db, 3);
    const secondAgent = await db.insert(agents).values({
      companyId: fixture.company.id,
      name: `Second Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning().then((rows) => rows[0]!);
    const agentProfile = await db.insert(toolProfiles).values({
      companyId: fixture.company.id,
      profileKey: `second-agent-${randomUUID()}`,
      name: `Second agent profile ${randomUUID()}`,
      defaultAction: "allow",
    }).returning().then((rows) => rows[0]!);
    await db.insert(toolProfileBindings).values({
      companyId: fixture.company.id,
      profileId: agentProfile.id,
      targetType: "agent",
      targetId: secondAgent.id,
    });
    const disabledConnection = await db.insert(toolConnections).values({
      companyId: fixture.company.id,
      applicationId: fixture.application.id,
      name: "Disabled connection",
      uid: `test/${randomUUID()}`,
      transport: "mcp_remote",
      status: "disabled",
      enabled: false,
      healthStatus: "ok",
      config: { url: "https://8.8.8.8/mcp" },
    }).returning().then((rows) => rows[0]!);
    const disabledEntry = await db.insert(toolCatalogEntries).values({
      companyId: fixture.company.id,
      applicationId: fixture.application.id,
      connectionId: disabledConnection.id,
      name: "disabled_tool",
      toolName: "disabled_tool",
      riskLevel: "read",
      versionHash: randomUUID(),
    }).returning().then((rows) => rows[0]!);

    const requestFor = (entry: { id: string; connectionId: string; toolName: string }) => ({
      catalogEntryId: entry.id,
      connectionId: entry.connectionId,
      toolName: entry.toolName,
      arguments: {},
    });
    const firstAgentActor = { actorType: "agent" as const, actorId: fixture.agent.id, agentId: fixture.agent.id };
    const secondAgentActor = { actorType: "agent" as const, actorId: secondAgent.id, agentId: secondAgent.id };
    const inputs: ToolAccessDecisionInput[] = [
      ...fixture.entries.map((entry) => ({
        companyId: fixture.company.id,
        actor: firstAgentActor,
        runContext: { heartbeatRunId: fixture.run.id, gatewayId: fixture.namedGateway.id },
        request: requestFor(entry),
      })),
      ...fixture.entries.map((entry) => ({
        companyId: fixture.company.id,
        actor: secondAgentActor,
        request: requestFor(entry),
      })),
      {
        companyId: fixture.company.id,
        actor: secondAgentActor,
        // The run belongs to the first agent.
        runContext: { heartbeatRunId: fixture.run.id },
        request: requestFor(fixture.entries[3]!),
      },
      {
        companyId: fixture.company.id,
        actor: secondAgentActor,
        request: requestFor(disabledEntry),
      },
      {
        companyId: fixture.company.id,
        actor: secondAgentActor,
        // A catalog entry of another company is not in this company's catalog.
        request: requestFor(other.entries[0]!),
      },
      {
        companyId: fixture.company.id,
        actor: secondAgentActor,
        request: { connectionId: fixture.connection.id, toolName: "tool_0004", arguments: {} },
      },
      {
        companyId: fixture.company.id,
        actor: secondAgentActor,
        // The database matches a uuid in any letter case.
        request: { ...requestFor(fixture.entries[4]!), catalogEntryId: fixture.entries[4]!.id.toUpperCase() },
      },
      {
        companyId: fixture.company.id,
        actor: { actorType: "system", actorId: fixture.company.id },
        request: requestFor(fixture.entries[4]!),
      },
    ];

    const policy = toolAccessPolicyService(db);
    const uncached = [];
    for (const input of inputs) uncached.push(await policy.decide(input));
    // One cache across mixed actors and runs: the keys must keep them apart.
    const cache = createToolAccessDecisionCache();
    const cached = await Promise.all(inputs.map((input) => policy.decide(input, { cache })));

    expect(cached).toEqual(uncached);
    expect(new Set(uncached.map((decision) => decision.reasonCode))).toEqual(new Set([
      "allow_profile",
      "deny_default",
      "deny_policy_block",
      "requires_approval_policy",
      "deny_run_context_mismatch",
      "deny_disabled_connection",
      "deny_missing_tool",
    ]));
  });

  it("reads fresh rows for a decision that consumes a rate limit", async () => {
    const fixture = await createListingFixture(db, 3);
    const policy = toolAccessPolicyService(db);
    const cache = createToolAccessDecisionCache();

    await policy.decide({
      companyId: fixture.company.id,
      actor: { actorType: "agent", actorId: fixture.agent.id, agentId: fixture.agent.id },
      runContext: { heartbeatRunId: fixture.run.id },
      request: {
        catalogEntryId: fixture.entries[0]!.id,
        connectionId: fixture.connection.id,
        toolName: "tool_0000",
        arguments: {},
      },
      consumeRateLimit: true,
    }, { cache });

    expect(cache.size).toBe(0);
  });
});
