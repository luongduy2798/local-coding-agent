using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;

static string? FindVersionDir(string start)
{
    var dir = new DirectoryInfo(start);
    while (dir != null)
    {
        if (File.Exists(Path.Combine(dir.FullName, "server.mjs")) &&
            File.Exists(Path.Combine(dir.FullName, "version-manifest.json")) &&
            File.Exists(Path.Combine(dir.FullName, "package.json")))
        {
            return dir.FullName;
        }
        dir = dir.Parent;
    }
    return null;
}

static async Task<int> RunProcess(string fileName, string arguments, string workingDirectory)
{
    var psi = new ProcessStartInfo
    {
        FileName = fileName,
        Arguments = arguments,
        WorkingDirectory = workingDirectory,
        UseShellExecute = false,
        RedirectStandardOutput = true,
        RedirectStandardError = true
    };
    using var process = Process.Start(psi);
    if (process == null) return 1;
    process.OutputDataReceived += (_, e) => { if (e.Data != null) Console.WriteLine(e.Data); };
    process.ErrorDataReceived += (_, e) => { if (e.Data != null) Console.Error.WriteLine(e.Data); };
    process.BeginOutputReadLine();
    process.BeginErrorReadLine();
    await process.WaitForExitAsync();
    return process.ExitCode;
}

static async Task<string?> ReadProcessOutput(string fileName, string arguments, string workingDirectory)
{
    try
    {
        var psi = new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        using var process = Process.Start(psi);
        if (process == null) return null;
        var stdout = await process.StandardOutput.ReadToEndAsync();
        await process.WaitForExitAsync();
        return process.ExitCode == 0 ? stdout.Trim() : null;
    }
    catch
    {
        return null;
    }
}

static async Task<bool> WaitForHttp(string url, string? expectedVersion, Process node)
{
    using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
    for (var i = 0; i < 30; i++)
    {
        if (node.HasExited) return false;
        try
        {
            using var res = await client.GetAsync(url);
            if (res.IsSuccessStatusCode)
            {
                using var health = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
                var reported = health.RootElement.TryGetProperty("version", out var versionProperty)
                    ? versionProperty.GetString()
                    : null;
                if (string.Equals(reported, expectedVersion, StringComparison.Ordinal)) return true;
            }
        }
        catch
        {
            // Keep waiting while Node starts.
        }
        await Task.Delay(500);
    }
    return false;
}

var startDir = args.Length > 0 ? Path.GetFullPath(args[0]) : AppContext.BaseDirectory;
var versionDir = FindVersionDir(startDir);
if (versionDir == null)
{
    Console.Error.WriteLine("Could not find a version folder containing server.mjs, package.json, and version-manifest.json.");
    Console.Error.WriteLine("Put this exe under a standalone version folder, for example v5.0.0-local-agent-studio\\dist\\LocalAgentStudio.exe.");
    Console.ReadKey(intercept: true);
    return 1;
}

var manifestPath = Path.Combine(versionDir, "version-manifest.json");
using var manifestDoc = JsonDocument.Parse(await File.ReadAllTextAsync(manifestPath));
var root = manifestDoc.RootElement;
var product = root.TryGetProperty("productName", out var productProp) ? productProp.GetString() : "Local Agent Studio";
var version = root.TryGetProperty("version", out var versionProp) ? versionProp.GetString() : "unknown";
var minimumNodeVersionText = root.TryGetProperty("minimumNodeVersion", out var minimumNodeVersionProp)
    ? minimumNodeVersionProp.GetString() ?? "18.0.0"
    : "18.0.0";
if (!Version.TryParse(minimumNodeVersionText, out var minimumNodeVersion)) minimumNodeVersion = new Version(18, 0, 0);
var port = Environment.GetEnvironmentVariable("LCA_STUDIO_PORT");
if (string.IsNullOrWhiteSpace(port))
{
    port = root.TryGetProperty("defaultPort", out var portProp) ? portProp.GetInt32().ToString() : "5177";
}

Console.Title = $"{product} {version}";
Console.WriteLine($"{product} {version}");
Console.WriteLine($"Version folder: {versionDir}");
Console.WriteLine($"URL: http://127.0.0.1:{port}");

var nodeVersionText = await ReadProcessOutput("node", "--version", versionDir);
var normalizedNodeVersion = nodeVersionText?.TrimStart('v').Split('-')[0];
if (normalizedNodeVersion == null || !Version.TryParse(normalizedNodeVersion, out var nodeVersion))
{
    Console.Error.WriteLine($"Node.js {minimumNodeVersion}+ is required but node was not found.");
    Console.ReadKey(intercept: true);
    return 1;
}
if (nodeVersion < minimumNodeVersion)
{
    Console.Error.WriteLine($"Node.js {minimumNodeVersion}+ is required. Found {nodeVersionText}.");
    Console.ReadKey(intercept: true);
    return 1;
}
Console.WriteLine($"Node.js: {nodeVersionText}");

if (!Directory.Exists(Path.Combine(versionDir, "node_modules")))
{
    Console.WriteLine("node_modules not found. Running locked dependency install...");
    var npmExit = await RunProcess("npm.cmd", "ci --ignore-scripts --no-fund", versionDir);
    if (npmExit != 0)
    {
        Console.Error.WriteLine($"npm install failed with exit code {npmExit}.");
        Console.ReadKey(intercept: true);
        return npmExit;
    }
}

var server = new ProcessStartInfo
{
    FileName = "node",
    Arguments = "server.mjs",
    WorkingDirectory = versionDir,
    UseShellExecute = false,
    RedirectStandardOutput = false,
    RedirectStandardError = false,
    CreateNoWindow = false
};

using var node = Process.Start(server);
if (node == null)
{
    Console.Error.WriteLine("Failed to start node server.mjs.");
    Console.ReadKey(intercept: true);
    return 1;
}

void StopNode()
{
    try
    {
        if (!node.HasExited) node.Kill(entireProcessTree: true);
    }
    catch
    {
        // Best effort during process shutdown.
    }
}

Console.CancelKeyPress += (_, eventArgs) =>
{
    eventArgs.Cancel = true;
    StopNode();
};
AppDomain.CurrentDomain.ProcessExit += (_, _) => StopNode();

var url = $"http://127.0.0.1:{port}";
if (await WaitForHttp(url + "/api/health", version, node))
{
    if (Environment.GetEnvironmentVariable("LCA_STUDIO_NO_BROWSER") == "1")
    {
        Console.WriteLine("Server is ready. Browser opening is disabled by LCA_STUDIO_NO_BROWSER=1.");
    }
    else
    {
        Console.WriteLine("Server is ready. Opening browser...");
        Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
    }
}
else
{
    Console.WriteLine("Server started but health check did not respond yet. Open the URL manually if needed.");
}

Console.WriteLine("Keep this window open while testing. Press Ctrl+C or close this window to stop.");
await node.WaitForExitAsync();
return node.ExitCode;
