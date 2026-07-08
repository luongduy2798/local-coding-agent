// Local Coding Agent
// Copyright (c) 2026 Lương Duy
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace LocalCodingAgentTray;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // Headless helper: stop any running MCP server + tunnel and exit.
        if (args.Length > 0 && args[0] == "--kill-strays")
        {
            var cfg = AppConfig.Load();
            var n = ProcessSupervisor.KillStrayInstances(cfg.ServerScript, Console.WriteLine);
            Console.WriteLine($"killed {n}");
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}
