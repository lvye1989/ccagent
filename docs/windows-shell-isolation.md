# Windows shell process isolation

Windows shell isolation is opt-in. Default behavior stays native Windows.
Set the following in your **user** settings (or managed policy), after preparing
Docker Desktop in Linux-container mode and a trusted image locally:

```json
{
  "sandbox": {
    "enabled": true,
    "docker": {
      "image": "mcr.microsoft.com/powershell:lts-debian-12"
    }
  }
}
```

The default image must provide `/bin/bash` and `pwsh`. An organization can build,
audit and preinstall its own image with these programs and required tools. Pin a
digest for reproducibility. CCAGENT inspects the local image, then runs its exact
image ID with `--pull=never`; it never downloads images or starts Docker itself.
Use `/doctor` or the application isolation status to see whether the engine and
configured image are ready.

The backend connects only to Docker Desktop's local Linux-engine named pipe.
Remote Docker contexts and `DOCKER_HOST` cannot change its execution destination.
If the engine/image is missing, settings are invalid, or policy cannot be
satisfied, the shell command fails without running on the host. On Windows,
`dangerouslyDisableSandbox`, `allowUnsandboxedCommands` and `excludedCommands`
cannot bypass an enabled sandbox. A repository's settings cannot turn off user
isolation or select a different image.

## Files and commands

- `/workspace` contains the selected project, mounted **read-only**.
- `/output` is writable and maps to `output/sandbox` inside that project. CCAGENT
  checks output ancestors and rejects symbolic links/junctions and paths outside
  the project. The output folder is an explicit fixed write allowance of this
  opt-in backend.
- `/tmp` is temporary container storage. Its contents disappear after cleanup;
  use `/output` for deliverables the application must read.
- Commands use **Linux paths**. PowerShell runs Linux `pwsh`, not Windows
  PowerShell 5.1. Windows COM, registry, drive-letter paths, desktop applications
  and Rhino/Photoshop automation are unavailable inside the container.
- Source editing can continue through the application's permission-checked file
  tools. Those tools are separate from process isolation.

The container receives no host application environment or credential directory.
Project files remain visible, including secrets deliberately kept inside that
project; this is not a secret scrubber. Do not select a drive root, user home or
folder containing the application's credential directory as the project.

## Enforced policy and scope

Containers run with network disabled, a read-only root filesystem, UID/GID
65534, all capabilities dropped, no new privileges, private IPC, a 128-process
limit, 1 GiB memory limit and two-CPU limit. Only the project and its dedicated
output folder are bind-mounted. The Docker daemon socket and arbitrary host
directories are never mounted. The temporary filesystem has a 256 MiB limit and
`nosuid,nodev,noexec` flags. The trusted image supplies the executable programs.

The initial backend has a fixed policy. Custom filesystem settings, network
allowlists, read-deny rules, and write-deny rules overlapping `/output` are
rejected rather than silently approximated. Container resource/security options
cannot be overridden in `sandbox.docker` (only `image` is supported). Network
deny rules are satisfied by disabling all container networking.

Each command has a unique container. Completion, cancellation and timeout await
daemon-side forced removal; killing the attached Docker client alone is not
treated as workload termination. If Docker becomes unavailable during removal,
the application reports cleanup as unconfirmed. Check Docker for containers
labelled `ccagent.sandbox=true` after unconfirmed removal or a hard worker crash.

This isolates **Bash and PowerShell commands**. MCP servers, document converters,
file tools, desktop automation and the main application process remain outside
this backend. Container isolation also depends on the installed Docker/OS and
trusted image; it is not a claim that every application tool is sandboxed.

## Verification

```powershell
node --import tsx src/scripts/test-windows-shell-isolation.ts
npm run test:sandbox
npm run test:bash-windows
```

The first script distinguishes dependency-injected lifecycle tests from checks
against the installed Docker CLI. It covers unavailable engine/image, no host
fallback, settings trust, output junctions, cancellation, timeout and visible
cleanup errors. To additionally test an already-prepared real container:

```powershell
node --import tsx src/scripts/test-windows-shell-isolation.ts --live
```

`--live` fails if the engine or image is unavailable; it does not silently skip
or pull an image. `CCAGENT_ISOLATION_TEST_IMAGE` can select a preinstalled test
image. All filesystem checks use an owned temporary project.

References: [Docker run options](https://docs.docker.com/engine/containers/run/),
[read-only and bind mounts](https://docs.docker.com/engine/storage/bind-mounts/),
[PowerShell containers](https://learn.microsoft.com/en-us/powershell/scripting/install/powershell-in-docker).
