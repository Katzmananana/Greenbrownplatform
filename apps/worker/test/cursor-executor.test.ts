import { describe, expect, it, vi } from "vitest";
import {
  APPROVED_CURSOR_REPOSITORY,
  buildCreateAgentBody,
  createCursorCloudClient,
  cursorAgentIdForDispatch,
  isApprovedRepository,
  readCursorExecutorConfig,
  readProviderGit,
} from "@gb/cursor-cloud";

const KEY = "code.run-1.0";

describe("cursor cloud agents contract (mocked, not a live launch)", () => {
  it("refuses every repository except the approved Greenbrownplatform target", () => {
    expect(isApprovedRepository(APPROVED_CURSOR_REPOSITORY)).toBe(true);
    expect(isApprovedRepository("https://github.com/Katzmananana/Greenbrownplatform.git")).toBe(
      true,
    );
    expect(isApprovedRepository("github.com/Katzmananana/Greenbrownplatform")).toBe(true);
    expect(isApprovedRepository("https://github.com/Katzmananana/talentfit")).toBe(false);
    expect(isApprovedRepository("https://github.com/Katzmananana/Greenbrownplatform-evil")).toBe(
      false,
    );
  });

  it("fails closed unless executor, credential, and allowlist are all explicit", () => {
    expect(readCursorExecutorConfig({}).mode).toBe("off");
    expect(readCursorExecutorConfig({ GB_CURSOR_EXECUTOR: "yes" }).mode).toBe("refused");
    expect(
      readCursorExecutorConfig({
        GB_CURSOR_EXECUTOR: "1",
        GB_CURSOR_REPO_URL: APPROVED_CURSOR_REPOSITORY,
      }),
    ).toMatchObject({ mode: "refused", reason: "cursor_credential_missing" });
    expect(
      readCursorExecutorConfig({
        GB_CURSOR_EXECUTOR: "1",
        CURSOR_API_KEY: "test-key",
        GB_CURSOR_REPO_URL: "https://github.com/Katzmananana/talentfit",
      }),
    ).toMatchObject({ mode: "refused", reason: "cursor_repo_not_allowlisted" });
    expect(
      readCursorExecutorConfig({
        GB_CURSOR_EXECUTOR: "1",
        CURSOR_API_KEY: "test-key",
        GB_CURSOR_REPO_URL: APPROVED_CURSOR_REPOSITORY,
      }),
    ).toMatchObject({
      mode: "ready",
      repoUrl: APPROVED_CURSOR_REPOSITORY,
      startingRef: "main",
      apiBase: "https://api.cursor.com",
    });
  });

  it("builds a documented create body and does not send a model or envVars", () => {
    const body = buildCreateAgentBody({
      idempotencyKey: KEY,
      requestText: "add a status page",
      planText: "fixture plan, not a model",
      repoUrl: APPROVED_CURSOR_REPOSITORY,
      startingRef: "main",
      runId: "run-1",
    });
    expect(body.agentId).toBe(cursorAgentIdForDispatch(KEY));
    expect(body.agentId).toMatch(/^bc-[0-9a-f-]{36}$/);
    expect(body.mode).toBe("agent");
    expect(body.workOnCurrentBranch).toBe(false);
    expect(body.autoCreatePR).toBe(true);
    expect(body.repos).toEqual([{ url: APPROVED_CURSOR_REPOSITORY, startingRef: "main" }]);
    expect(body.prompt.text).toContain("add a status page");
    expect(body.prompt.text).toContain("fixture plan, not a model");
    expect(body).not.toHaveProperty("envVars");
    expect(body).not.toHaveProperty("model");
  });

  it("posts once to /v1/agents and reads repo, branch, and PR only from the run", async () => {
    const calls: { method: string; url: string; body?: unknown; authorization?: string }[] = [];
    const agentId = cursorAgentIdForDispatch(KEY);
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (init?.method === "POST" && url.endsWith("/v1/agents")) {
        return json({
          agent: {
            id: agentId,
            latestRunId: "run-mock-1",
            url: `https://cursor.com/agents/${agentId}`,
          },
          run: { id: "run-mock-1", agentId, status: "CREATING" },
        });
      }
      return json({
        id: "run-mock-1",
        agentId,
        status: "FINISHED",
        result: "mock provider result, not a live agent",
        git: {
          branches: [
            {
              repoUrl: "github.com/Katzmananana/Greenbrownplatform",
              branch: "cursor/mock-branch",
              prUrl: "https://github.com/Katzmananana/Greenbrownplatform/pull/99",
              commitSha: "not-a-commit",
            },
          ],
        },
      });
    });
    const client = createCursorCloudClient({
      apiKey: "test-key",
      apiBase: "http://127.0.0.1:9",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const created = await client.createAgent(
      buildCreateAgentBody({
        idempotencyKey: KEY,
        requestText: "add a status page",
        planText: "fixture plan, not a model",
        repoUrl: APPROVED_CURSOR_REPOSITORY,
        startingRef: "main",
        runId: "run-1",
      }),
    );
    const run = await client.getRun(created.agent.id, created.run.id);
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "POST /v1/agents",
      `GET /v1/agents/${agentId}/runs/run-mock-1`,
    ]);
    expect(calls[0]?.authorization).toBe("Bearer test-key");
    expect(readProviderGit(run)).toEqual({
      repoUrl: "github.com/Katzmananana/Greenbrownplatform",
      branch: "cursor/mock-branch",
      prUrl: "https://github.com/Katzmananana/Greenbrownplatform/pull/99",
    });
    expect(readProviderGit(run)).not.toHaveProperty("commitSha");
  });

  it("treats 409 agent_id_conflict as an existing agent and does not invent a commit", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return json({ code: "agent_id_conflict" }, 409);
      }
      return json({ id: "missing" }, 404);
    });
    const client = createCursorCloudClient({
      apiKey: "test-key",
      apiBase: "http://127.0.0.1:9",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.createAgent(
        buildCreateAgentBody({
          idempotencyKey: KEY,
          requestText: "request",
          planText: "plan",
          repoUrl: APPROVED_CURSOR_REPOSITORY,
          startingRef: "main",
          runId: "run-1",
        }),
      ),
    ).rejects.toMatchObject({ kind: "conflict", code: "agent_id_conflict", status: 409 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not accept a git repo outside the allowlist", () => {
    expect(
      readProviderGit({
        git: { branches: [{ repoUrl: "github.com/Katzmananana/talentfit", branch: "cursor/x" }] },
      }),
    ).toBeNull();
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
