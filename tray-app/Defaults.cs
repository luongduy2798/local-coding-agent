// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace LocalCodingAgentTray;

/// <summary>
/// Best-effort default paths. Everything here is editable in the UI and
/// persisted to config, so any machine can override.
/// </summary>
public static class Defaults
{
    /// <summary>
    /// Repo root: walk up from the exe location looking for server/server.mjs.
    /// Falls back to the exe directory if not found.
    /// </summary>
    public static string BaseDir()
    {
        var dir = AppContext.BaseDirectory;
        for (int i = 0; i < 8 && !string.IsNullOrEmpty(dir); i++)
        {
            if (File.Exists(Path.Combine(dir, "server", "server.mjs")))
                return dir;
            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar)) ?? "";
        }
        return AppContext.BaseDirectory;
    }

    public static string McpAppDir() => Path.Combine(BaseDir(), "server");

    // tunnel-client.exe is NOT shipped (it is proprietary - see README). Put it
    // under tools/ or set the path in the app. This is only the suggested spot.
    public static string TunnelExe() => Path.Combine(BaseDir(), "tools", "tunnel-client.exe");

    public static string TunnelProfileDir() => Path.Combine(BaseDir(), "tools", "profiles");

    // No auto-guess of a specific repo: let the user choose their workspace.
    public static string GuessWorkspace() => "";
}
