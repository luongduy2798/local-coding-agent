# Windows Launcher

This small .NET launcher builds `LocalAgentStudio.exe` for the standalone
version folders.

The exe is intentionally a launcher, not a bundled Node runtime:

- it finds the version folder that contains `server.mjs`,
- runs `npm install` if `node_modules` is missing,
- starts `node server.mjs`,
- opens the local browser URL.

Build:

```powershell
dotnet publish .\LocalAgentStudioLauncher.csproj -c Release -r win-x64 --self-contained true -o publish\win-x64
```

Copy `publish\win-x64\LocalAgentStudio.exe` into a version folder's `dist\`
directory, for example:

```text
v5.0.0-local-agent-studio\dist\LocalAgentStudio.exe
```
