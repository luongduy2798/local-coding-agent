import type {
  ApiErrorBody,
  ApiRevision,
  ChangeEvent,
  ChangeContentResponse,
  ChangeListResponse,
  ChangeMutationResponse,
  HealthResponse,
  ReviewScope,
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
    private readonly getInstanceNonce: (refresh?: boolean) => Promise<string | undefined> =
      async () => undefined,
  ) {}

  async health(signal?: AbortSignal): Promise<HealthResponse> {
    try {
      return await this.healthDetails(signal, false);
    } catch (error) {
      if (!(error instanceof LcaApiError) || ![401, 403].includes(error.status)) throw error;
      return this.healthDetails(signal, true);
    }
  }

  listChanges(
    limit: number,
    scope: ReviewScope = {},
    options: { signal?: AbortSignal; sinceRevision?: ApiRevision } = {},
  ): Promise<ChangeListResponse> {
    const query = scopeQuery(scope);
    query.set("limit", String(limit));
    if (options.sinceRevision !== undefined) {
      query.set("revision", String(options.sinceRevision));
    }
    const headers = new Headers();
    if (options.sinceRevision !== undefined) {
      headers.set("if-none-match", `"${String(options.sinceRevision)}"`);
    }
    return this.request<ChangeListResponse>(`/changes?${query.toString()}`, {
      signal: options.signal,
      headers,
    }, true, true);
  }

  getContent(
    changeId: string,
    filePath: string,
    side: "before" | "after",
    scope: ReviewScope = {},
    signal?: AbortSignal,
  ): Promise<ChangeContentResponse> {
    const query = scopeQuery(scope);
    query.set("path", filePath);
    query.set("side", side);
    return this.request<ChangeContentResponse>(
      `/changes/${encodeURIComponent(changeId)}/content?${query.toString()}`,
      { signal },
    );
  }

  undo(
    changeId: string,
    paths?: string[],
    scope: ReviewScope = {},
  ): Promise<ChangeMutationResponse> {
    const query = scopeQuery(scope);
    return this.request<ChangeMutationResponse>(
      `/changes/${encodeURIComponent(changeId)}/undo?${query.toString()}`,
      {
        method: "POST",
        body: JSON.stringify({
          ...(paths?.length ? { paths } : {}),
          ...(scope.workspaceId ? { workspace_id: scope.workspaceId } : {}),
          ...(scope.taskId ? { task_id: scope.taskId } : {}),
        }),
      },
    );
  }

  reapply(
    changeId: string,
    paths?: string[],
    scope: ReviewScope = {},
  ): Promise<ChangeMutationResponse> {
    const query = scopeQuery(scope);
    return this.request<ChangeMutationResponse>(
      `/changes/${encodeURIComponent(changeId)}/reapply?${query.toString()}`,
      {
        method: "POST",
        body: JSON.stringify({
          ...(paths?.length ? { paths } : {}),
          ...(scope.workspaceId ? { workspace_id: scope.workspaceId } : {}),
          ...(scope.taskId ? { task_id: scope.taskId } : {}),
        }),
      },
    );
  }

  undoAll(scope: ReviewScope = {}): Promise<{ ok: boolean; undone: string[] }> {
    const query = scopeQuery(scope);
    return this.request(`/changes/undo-all?${query.toString()}`, { method: "POST" });
  }

  clear(scope: ReviewScope = {}): Promise<{ ok: boolean; deleted: number }> {
    const query = scopeQuery(scope);
    return this.request(`/changes?${query.toString()}`, { method: "DELETE" });
  }

  deleteTask(
    taskId: string,
    workspaceId: string,
  ): Promise<{ ok: boolean; task_id: string; deleted: number; history_deleted: number }> {
    const query = new URLSearchParams({ workspace_id: workspaceId });
    return this.request(`/tasks/${encodeURIComponent(taskId)}?${query.toString()}`, {
      method: "DELETE",
    });
  }

  deleteWorkspaceTasks(
    workspaceId: string,
  ): Promise<{ ok: boolean; workspace_id: string; deleted: number; history_deleted: number }> {
    const query = new URLSearchParams({ workspace_id: workspaceId });
    return this.request(`/tasks?${query.toString()}`, { method: "DELETE" });
  }

  async watchChangeEvents(
    {
      scope = {},
      sinceRevision,
      endpoint = "/changes/events",
      signal,
      onEvent,
    }: {
      scope?: ReviewScope;
      sinceRevision?: ApiRevision;
      endpoint?: string;
      signal: AbortSignal;
      onEvent: (event: ChangeEvent) => void;
    },
  ): Promise<"ended" | "unsupported"> {
    const query = scopeQuery(scope);
    if (sinceRevision !== undefined) query.set("since_revision", String(sinceRevision));
    const separator = endpoint.includes("?") ? "&" : "?";
    const requestPath = query.size ? `${endpoint}${separator}${query.toString()}` : endpoint;
    const headers = await this.headers(undefined, true);
    headers.set("accept", "text/event-stream");
    if (sinceRevision !== undefined) headers.set("last-event-id", String(sinceRevision));

    let response: Response;
    const handshake = createTimedSignal(signal, 7000);
    try {
      response = await fetch(this.resolveUrl(requestPath), {
        headers,
        signal: handshake.signal,
      });
    } catch (error) {
      handshake.dispose();
      if (isAbortError(error)) return "ended";
      throw error;
    }
    handshake.clearTimeout();
    try {
      if ([404, 405, 406, 501].includes(response.status)) return "unsupported";
      if (!response.ok) {
        const body = await parseResponseBody(response);
        throw new LcaApiError(response.status, body as ApiErrorBody);
      }
      if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
        await response.body?.cancel();
        return "unsupported";
      }
      if (!response.body) return "ended";

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = normalizeSseNewlines(buffer);
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = parseSseBlock(block);
            if (event) onEvent(event);
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch (error) {
        if (!isAbortError(error) && !signal.aborted) throw error;
      } finally {
        reader.releaseLock();
      }
      return "ended";
    } finally {
      handshake.dispose();
    }
  }

  private async request<T>(
    requestPath: string,
    init: RequestInit = {},
    authenticated = true,
    allowNotModified = false,
  ): Promise<T> {
    const headers = await this.headers(init.headers, authenticated);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const abort = createTimedSignal(init.signal, 7000);
    try {
      const response = await fetch(this.resolveUrl(requestPath), {
        ...init,
        headers,
        signal: abort.signal,
      });
      if (allowNotModified && response.status === 304) {
        return { notModified: true } as T;
      }
      const body = await parseResponseBody(response);
      if (!response.ok) {
        throw new LcaApiError(response.status, body as ApiErrorBody);
      }
      return body as T;
    } catch (error) {
      if (error instanceof LcaApiError) throw error;
      if (isAbortError(error)) {
        if (init.signal?.aborted) throw error;
        throw new Error("LCA connection timed out.");
      }
      throw error;
    } finally {
      abort.dispose();
    }
  }

  private async headers(
    source: HeadersInit | undefined,
    authenticated: boolean,
  ): Promise<Headers> {
    const headers = new Headers(source);
    headers.set("accept", "application/json");
    const instanceNonce = await this.getInstanceNonce(false);
    if (instanceNonce) headers.set("x-lca-instance-nonce", instanceNonce);
    if (authenticated) {
      const token = await this.getToken();
      if (token) headers.set("authorization", `Bearer ${token}`);
    }
    return headers;
  }

  private async healthDetails(
    signal: AbortSignal | undefined,
    refreshNonce: boolean,
  ): Promise<HealthResponse> {
    const headers = new Headers();
    const instanceNonce = await this.getInstanceNonce(refreshNonce);
    if (instanceNonce) headers.set("x-lca-instance-nonce", instanceNonce);
    return this.request<HealthResponse>(
      "/healthz/details",
      { signal, headers },
      true,
    );
  }

  private resolveUrl(requestPath: string): string {
    const base = new URL(`${this.baseUrl}/`);
    const resolved = new URL(requestPath, base);
    if (resolved.origin !== base.origin) {
      throw new Error("LCA event and API endpoints must use the configured server origin.");
    }
    return resolved.toString();
  }
}

function scopeQuery(scope: ReviewScope): URLSearchParams {
  const query = new URLSearchParams();
  if (scope.workspaceId) query.set("workspace_id", scope.workspaceId);
  if (scope.taskId) query.set("task_id", scope.taskId);
  return query;
}

function createTimedSignal(
  source: AbortSignal | null | undefined,
  timeoutMs: number,
): { signal: AbortSignal; clearTimeout: () => void; dispose: () => void } {
  const controller = new AbortController();
  const abortFromSource = () => controller.abort(source?.reason);
  if (source?.aborted) abortFromSource();
  else source?.addEventListener("abort", abortFromSource, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clearTimeout: () => clearTimeout(timeout),
    dispose: () => {
      clearTimeout(timeout);
      source?.removeEventListener("abort", abortFromSource);
    },
  };
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function parseSseBlock(block: string): ChangeEvent | undefined {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value || "message";
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length && !id) return undefined;
  const raw = data.join("\n");
  let parsed: unknown = raw;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Plain-text SSE data is valid.
    }
  }
  const object = parsed && typeof parsed === "object"
    ? parsed as { revision?: ApiRevision }
    : undefined;
  return {
    event,
    revision: object?.revision ?? id,
    data: parsed,
  };
}

function normalizeSseNewlines(value: string): string {
  // Keep a trailing CR until the next chunk so a split CRLF is not mistaken
  // for two independent line endings and an empty SSE record.
  const trailingCr = value.endsWith("\r");
  const complete = trailingCr ? value.slice(0, -1) : value;
  return complete.replace(/\r\n/g, "\n").replace(/\r/g, "\n") +
    (trailingCr ? "\r" : "");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
