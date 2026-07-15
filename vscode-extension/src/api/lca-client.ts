import type {
  ApiErrorBody,
  ChangeContentResponse,
  ChangeListResponse,
  ChangeMutationResponse,
  HealthResponse
} from "./api-types.js";

export class LcaApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(body.message || body.error || `LCA request failed with HTTP ${status}`);
    this.name = "LcaApiError";
  }
}

export class LcaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => Promise<string | undefined>,
  ) {}

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/healthz", {}, false);
  }

  listChanges(limit: number): Promise<ChangeListResponse> {
    return this.request<ChangeListResponse>(`/changes?limit=${encodeURIComponent(limit)}`);
  }

  getContent(
    changeId: string,
    filePath: string,
    side: "before" | "after",
  ): Promise<ChangeContentResponse> {
    const query = new URLSearchParams({ path: filePath, side });
    return this.request<ChangeContentResponse>(
      `/changes/${encodeURIComponent(changeId)}/content?${query.toString()}`,
    );
  }

  undo(changeId: string, paths?: string[]): Promise<ChangeMutationResponse> {
    return this.request<ChangeMutationResponse>(
      `/changes/${encodeURIComponent(changeId)}/undo`,
      {
        method: "POST",
        body: JSON.stringify(paths?.length ? { paths } : {}),
      },
    );
  }

  reapply(changeId: string, paths?: string[]): Promise<ChangeMutationResponse> {
    return this.request<ChangeMutationResponse>(
      `/changes/${encodeURIComponent(changeId)}/reapply`,
      {
        method: "POST",
        body: JSON.stringify(paths?.length ? { paths } : {}),
      },
    );
  }

  undoAll(): Promise<{ ok: boolean; undone: string[] }> {
    return this.request("/changes/undo-all", { method: "POST" });
  }

  clear(): Promise<{ ok: boolean; deleted: number }> {
    return this.request("/changes", { method: "DELETE" });
  }

  private async request<T>(
    requestPath: string,
    init: RequestInit = {},
    authenticated = true,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (authenticated) {
      const token = await this.getToken();
      if (token) headers.set("authorization", `Bearer ${token}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(`${this.baseUrl}${requestPath}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { message: text };
        }
      }
      if (!response.ok) {
        throw new LcaApiError(response.status, body as ApiErrorBody);
      }
      return body as T;
    } catch (error) {
      if (error instanceof LcaApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("LCA connection timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
