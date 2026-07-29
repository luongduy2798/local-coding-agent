import React, { useMemo, useState } from "react";
import type {
  WorkspaceMemoryFreshness,
  WorkspaceMemoryInput,
  WorkspaceMemoryItem,
  WorkspaceMemoryKind,
  WorkspaceMemoryLifecycle,
} from "../api/api-types.js";
import type { WorkspaceMemoryViewState } from "./protocol.js";

const KINDS: Array<{ value: WorkspaceMemoryKind; label: string }> = [
  { value: "project_goal", label: "Project goal" },
  { value: "architecture_decision", label: "Architecture decision" },
  { value: "constraint", label: "Constraint" },
  { value: "known_issue", label: "Known issue" },
  { value: "open_question", label: "Open question" },
  { value: "user_preference", label: "User preference" },
  { value: "verification_result", label: "Verification result" },
];

export function WorkspaceMemoryRoute({
  memory,
  workspaceLabel,
  busyAction,
  trusted,
  onBack,
  onRefresh,
  onRetryFailed,
  onSave,
  onUpdate,
  onTransition,
  onDelete,
  onSettings,
  onOpenPath,
}: {
  memory?: WorkspaceMemoryViewState;
  workspaceLabel: string;
  busyAction?: string;
  trusted: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onRetryFailed: () => void;
  onSave: (input: WorkspaceMemoryInput) => void;
  onUpdate: (id: string, input: WorkspaceMemoryInput) => void;
  onTransition: (id: string, action: string) => void;
  onDelete: (id: string) => void;
  onSettings: (input: WorkspaceMemoryInput) => void;
  onOpenPath: (path: string) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<WorkspaceMemoryKind | "all">("all");
  const [lifecycle, setLifecycle] = useState<WorkspaceMemoryLifecycle | "all">("all");
  const [freshness, setFreshness] = useState<WorkspaceMemoryFreshness | "all">("all");
  const [editing, setEditing] = useState<WorkspaceMemoryItem | null>(null);
  const [creating, setCreating] = useState(false);
  const items = useMemo(() => (memory?.items || []).filter((item) => {
    const needle = query.trim().toLowerCase();
    return (!needle || `${item.title} ${item.summary} ${item.tags.join(" ")} ${item.paths.join(" ")}`.toLowerCase().includes(needle)) &&
      (kind === "all" || item.kind === kind) &&
      (lifecycle === "all" || item.lifecycle === lifecycle) &&
      (freshness === "all" || item.freshness === freshness);
  }), [memory?.items, query, kind, lifecycle, freshness]);
  const readOnly = memory?.read_only === true || !trusted;

  return (
    <section className="memory-route">
      <div className="memory-route-toolbar">
        <button className="back-button" type="button" onClick={onBack}>← Back to workspace tasks</button>
        <button className="compact-action" type="button" disabled={Boolean(busyAction)} onClick={onRefresh}>Refresh</button>
      </div>
      <div className="memory-heading">
        <div>
          <div className="eyebrow">PERSISTENT WORKSPACE MEMORY</div>
          <h2>{workspaceLabel}</h2>
          <p>Durable cross-conversation context. Raw chat and private reasoning are never stored here.</p>
        </div>
        <button
          className="compact-action primary"
          type="button"
          disabled={readOnly || Boolean(busyAction)}
          onClick={() => { setCreating(true); setEditing(null); }}
        >New memory</button>
      </div>

      {memory?.error && <div className="scope-error-banner">{memory.error}</div>}
      {Boolean(memory?.outbox?.failed) && (
        <div className="scope-error-banner">
          <span>{memory?.outbox?.failed} queued Memory update{memory?.outbox?.failed === 1 ? "" : "s"} failed.</span>
          <button className="compact-action" type="button" disabled={readOnly || Boolean(busyAction)} onClick={onRetryFailed}>Retry failed</button>
        </div>
      )}
      {memory?.loading && !memory.items?.length && <div className="memory-loading">Loading workspace memory…</div>}
      {memory && (
        <>
          <div className="memory-metrics">
            <Metric label="Active" value={memory.counts.active} />
            <Metric label="Pinned" value={memory.counts.pinned} />
            <Metric label="Needs review" value={memory.counts.needs_review} />
            <Metric label="Pending jobs" value={(memory.outbox?.pending || 0) + (memory.outbox?.processing || 0) + (memory.outbox?.retrying || 0)} />
            <Metric label="Failed jobs" value={memory.outbox?.failed || 0} />
            <Metric label="Revision" value={memory.revision} />
          </div>

          <section className="memory-panel">
            <div className="memory-panel-heading"><div><h3>Adaptive auto-load</h3><p>Quick edits receive small path-aware context; normal and complex tasks receive the full bounded brief with no extra MCP round-trip. Durable task-close updates are queued and persisted in the background.</p></div></div>
            <div className="memory-settings">
              <Toggle label="Memory enabled" checked={memory.settings.enabled} disabled={readOnly || Boolean(busyAction)} onChange={(enabled) => onSettings({ enabled })} />
              <Toggle label="Adaptive auto-load on task_open" checked={memory.settings.auto_load} disabled={readOnly || Boolean(busyAction)} onChange={(auto_load) => onSettings({ auto_load })} />
              <Toggle label="Allow recent-task context when requested" checked={memory.settings.include_recent_tasks} disabled={readOnly || Boolean(busyAction)} onChange={(include_recent_tasks) => onSettings({ include_recent_tasks })} />
              <Toggle label="Local semantic search" checked={memory.settings.semantic_search} disabled={readOnly || Boolean(busyAction)} onChange={(semantic_search) => onSettings({ semantic_search })} />
            </div>
            {memory.semantic && (
              <p>
                Semantic model: {memory.semantic.ready ? "ready" : memory.semantic.state}
                {memory.semantic.model_id ? ` · ${memory.semantic.model_id}` : ""}
                {` · ${memory.semantic.current_items}/${memory.counts.active} active items indexed`}
                {memory.semantic.deadline_ms ? ` · ${memory.semantic.deadline_ms} ms fallback deadline` : ""}
              </p>
            )}
            <p>Full-mode preview. Light mode may return only matching path constraints, and skip mode returns none.</p>
            <pre className="memory-brief">{memory.brief || "No active memory is currently available for full-mode auto-load."}</pre>
          </section>

          {(creating || editing) && (
            <MemoryEditor
              item={editing}
              disabled={readOnly || Boolean(busyAction)}
              onCancel={() => { setCreating(false); setEditing(null); }}
              onSubmit={(input) => {
                if (editing) onUpdate(editing.id, { ...input, expected_revision: editing.revision });
                else onSave(input);
                setCreating(false);
                setEditing(null);
              }}
            />
          )}

          <div className="memory-filters">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search memory…" />
            <select value={kind} onChange={(event) => setKind(event.target.value as WorkspaceMemoryKind | "all")}>
              <option value="all">All kinds</option>{KINDS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </select>
            <select value={lifecycle} onChange={(event) => setLifecycle(event.target.value as WorkspaceMemoryLifecycle | "all")}>
              <option value="all">All lifecycle</option><option value="active">Active</option><option value="resolved">Resolved</option><option value="superseded">Superseded</option><option value="archived">Archived</option>
            </select>
            <select value={freshness} onChange={(event) => setFreshness(event.target.value as WorkspaceMemoryFreshness | "all")}>
              <option value="all">All freshness</option><option value="current">Current</option><option value="needs_review">Needs review</option><option value="stale">Stale</option>
            </select>
          </div>

          <div className="memory-list">
            {items.map((item) => (
              <MemoryCard
                key={item.id}
                item={item}
                disabled={readOnly || Boolean(busyAction)}
                onEdit={() => { setEditing(item); setCreating(false); }}
                onTransition={(action) => onTransition(item.id, action)}
                onDelete={() => onDelete(item.id)}
                onOpenPath={onOpenPath}
              />
            ))}
            {!memory.loading && items.length === 0 && <div className="memory-empty">No memory items match this view.</div>}
          </div>
        </>
      )}
    </section>
  );
}

function MemoryEditor({ item, disabled, onCancel, onSubmit }: {
  item: WorkspaceMemoryItem | null;
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (input: WorkspaceMemoryInput) => void;
}): React.JSX.Element {
  const [kind, setKind] = useState<WorkspaceMemoryKind>(item?.kind || "architecture_decision");
  const [title, setTitle] = useState(item?.title || "");
  const [summary, setSummary] = useState(item?.summary || "");
  const [paths, setPaths] = useState((item?.paths || []).join("\n"));
  const [tags, setTags] = useState((item?.tags || []).join(", "));
  const [pinned, setPinned] = useState(item?.pinned || false);
  const valid = title.trim().length > 0 && summary.trim().length > 0;
  return (
    <form className="memory-editor" onSubmit={(event) => {
      event.preventDefault();
      if (!valid) return;
      onSubmit({
        kind,
        title: title.trim(),
        summary: summary.trim(),
        paths: paths.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
        tags: tags.split(",").map((value) => value.trim()).filter(Boolean),
        pinned,
      });
    }}>
      <div className="memory-panel-heading"><div><h3>{item ? "Edit memory" : "New memory"}</h3><p>Store only durable, public project context.</p></div></div>
      <div className="memory-editor-grid">
        <label><span>Kind</span><select value={kind} onChange={(event) => setKind(event.target.value as WorkspaceMemoryKind)}>{KINDS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select></label>
        <label><span>Title</span><input value={title} maxLength={180} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="wide"><span>Summary</span><textarea value={summary} maxLength={2000} rows={5} onChange={(event) => setSummary(event.target.value)} /></label>
        <label className="wide"><span>Related paths, one per line</span><textarea value={paths} rows={3} onChange={(event) => setPaths(event.target.value)} /></label>
        <label><span>Tags, comma separated</span><input value={tags} onChange={(event) => setTags(event.target.value)} /></label>
        <label className="memory-checkbox"><input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} /> Prioritize in full Memory context</label>
      </div>
      <div className="memory-editor-actions"><button type="button" className="compact-action" onClick={onCancel}>Cancel</button><button type="submit" className="compact-action primary" disabled={disabled || !valid}>Save</button></div>
    </form>
  );
}

function MemoryCard({ item, disabled, onEdit, onTransition, onDelete, onOpenPath }: {
  item: WorkspaceMemoryItem;
  disabled: boolean;
  onEdit: () => void;
  onTransition: (action: string) => void;
  onDelete: () => void;
  onOpenPath: (path: string) => void;
}): React.JSX.Element {
  return (
    <article className={`memory-card freshness-${item.freshness}`}>
      <div className="memory-card-head"><div><div className="memory-card-badges"><span>{kindLabel(item.kind)}</span><span>{item.lifecycle}</span><span>{item.freshness.replace("_", " ")}</span>{item.pinned && <span>pinned</span>}</div><h3>{item.title}</h3></div><span className="memory-revision">r{item.revision}</span></div>
      <p>{item.summary}</p>
      {item.paths.length > 0 && <div className="memory-paths">{item.paths.map((path) => <button type="button" key={path} onClick={() => onOpenPath(path)}>{path}</button>)}</div>}
      {item.tags.length > 0 && <div className="memory-tags">{item.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>}
      <div className="memory-provenance">{item.source_task_id ? `Task ${item.source_task_id.slice(0, 16)}` : "User-managed"} · Updated {new Date(item.updated_at).toLocaleString()}</div>
      <div className="memory-card-actions">
        <button type="button" disabled={disabled} onClick={onEdit}>Edit</button>
        <button type="button" disabled={disabled} onClick={() => onTransition(item.pinned ? "unpin" : "pin")}>{item.pinned ? "Unpin" : "Pin"}</button>
        {item.freshness !== "current" && <button type="button" disabled={disabled} onClick={() => onTransition("current")}>Mark current</button>}
        {item.lifecycle === "active" && item.kind === "known_issue" && <button type="button" disabled={disabled} onClick={() => onTransition("resolve")}>Resolve</button>}
        {item.lifecycle === "archived" ? <button type="button" disabled={disabled} onClick={() => onTransition("restore")}>Restore</button> : <button type="button" disabled={disabled} onClick={() => onTransition("archive")}>Archive</button>}
        <button type="button" className="danger" disabled={disabled} onClick={onDelete}>Delete</button>
      </div>
    </article>
  );
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }): React.JSX.Element {
  return <label className="memory-toggle"><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}

function Metric({ label, value }: { label: string; value: number }): React.JSX.Element {
  return <div className="memory-metric"><strong>{value}</strong><span>{label}</span></div>;
}

function kindLabel(kind: WorkspaceMemoryKind): string {
  return KINDS.find((entry) => entry.value === kind)?.label || kind;
}
