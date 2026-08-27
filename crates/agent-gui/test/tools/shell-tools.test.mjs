import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createBashCall(command = "echo ready") {
  return {
    type: "toolCall",
    id: "call-bash",
    name: "Bash",
    arguments: {
      command,
      timeout_ms: 1000,
    },
  };
}

test("Bash compatibility tool uses native PowerShell policy for Claude Code on Windows", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "shell_run");
          return {
            exit_code: 0,
            shell: "powershell",
            platform: "windows",
            profile: "windows-powershell",
            shell_family: "powershell",
            stdout: "ready\n",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            cancelled: false,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 12,
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    runtimePlatform: "windows",
  });

  assert.match(bundle.tools[0].description, /runs native Windows PowerShell first/);
  assert.match(bundle.tools[0].description, /never uses WSL/);
  assert.match(bundle.tools[0].description, /PowerShell 5\.1-compatible syntax/);
  assert.doesNotMatch(bundle.tools[0].description, /Write POSIX\/bash syntax by default/);

  const result = await bundle.executeToolCall(createBashCall());

  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.provider_id, "claude_code");
  assert.equal(calls[0].args.max_timeout_ms, 600_000);
  assert.match(result.content[0].text, /platform: windows/);
  assert.match(result.content[0].text, /profile: windows-powershell/);
});

test("Bash compatibility tool uses the same native PowerShell policy for Codex", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "shell_run");
          return {
            exit_code: 0,
            shell: "powershell",
            platform: "windows",
            profile: "windows-powershell",
            shell_family: "powershell",
            stdout: "ready\n",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            cancelled: false,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 12,
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "codex",
    runtimePlatform: "windows",
  });

  assert.match(bundle.tools[0].description, /runs native Windows PowerShell first/);
  assert.match(bundle.tools[0].description, /never uses WSL/);
  assert.doesNotMatch(bundle.tools[0].description, /Git Bash \(POSIX semantics\)/);

  const result = await bundle.executeToolCall(createBashCall());

  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.provider_id, "codex");
  assert.equal(calls[0].args.max_timeout_ms, 30_000);
});

test("Bash tool schema allows larger timeout values but clamps for Codex", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "shell_run");
          return {
            exit_code: 0,
            shell: "pwsh",
            stdout: "ready\n",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            cancelled: false,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 12,
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "codex",
  });

  assert.match(JSON.stringify(bundle.tools[0].parameters), /"maximum":600000/);
  assert.equal(bundle.tools[0].parameters.additionalProperties, false);

  const result = await bundle.executeToolCall({
    ...createBashCall(),
    arguments: {
      command: "echo ready",
      timeout_ms: 60_000,
    },
  });

  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.timeout_ms, 30_000);
  assert.match(result.content[0].text, /timeout_ms: 30000/);
});

test("Bash tool rejects unsupported root arguments", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "codex",
  });

  const result = await bundle.executeToolCall({
    ...createBashCall(),
    arguments: {
      root: "workspace",
      command: "echo ready",
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unsupported argument: root/);
  assert.deepEqual(calls, []);
});

test("Bash tool rejects background commands that keep stdio attached", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    runtimePlatform: "linux",
  });

  const result = await bundle.executeToolCall(
    createBashCall("deno run --allow-net main.ts &"),
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Background Bash commands must detach stdout and stderr/);
  assert.match(result.content[0].text, /nohup command > \/tmp\/arcforge-task\.log 2>&1/);
  assert.deepEqual(calls, []);
});

test("Bash tool rejects background commands when redirects belong to another command", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    runtimePlatform: "linux",
  });

  const result = await bundle.executeToolCall(
    createBashCall("echo ok > /tmp/previous.log 2>&1; deno run --allow-net main.ts &"),
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Background Bash commands must detach stdout and stderr/);
  assert.deepEqual(calls, []);
});

test("Bash tool rejects background commands with only stderr append redirected", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    runtimePlatform: "linux",
  });

  const result = await bundle.executeToolCall(
    createBashCall("deno run --allow-net main.ts 2>> /tmp/server.err &"),
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Background Bash commands must detach stdout and stderr/);
  assert.deepEqual(calls, []);
});

test("Bash compatibility tool allows the PowerShell call operator on Windows", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "shell_run");
          return {
            exit_code: 0,
            shell: "powershell",
            platform: "windows",
            profile: "windows-powershell",
            shell_family: "powershell",
            stdout: "ok\n",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            cancelled: false,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 12,
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "codex",
    runtimePlatform: "windows",
  });

  const result = await bundle.executeToolCall(createBashCall("& '.\\script.ps1'"));

  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
});

test("Bash tool rejects POSIX heredocs before invoking Windows PowerShell", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "codex",
    runtimePlatform: "windows",
  });
  const commands = [
    "python - <<'PY'\nprint('ready')\nPY",
    "python <<EOF\nprint('ready')\nEOF",
    "psql connection-string << 'SQL'\nselect 1;\nSQL",
    "  py -3 - <<-PY\r\nprint('ready')\r\nPY",
    'python - <<< "print(\'ready\')"',
  ];

  for (const command of commands) {
    const result = await bundle.executeToolCall(createBashCall(command));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /POSIX heredoc syntax/);
    assert.match(result.content[0].text, /Windows PowerShell 5\.1/);
    assert.match(result.content[0].text, /If Write is available/);
    assert.match(result.content[0].text, /temporary \.py or \.sql file/);
    assert.match(result.content[0].text, /PowerShell here-string/);
    assert.match(result.content[0].text, /python -c/);
  }
  assert.deepEqual(calls, []);
});

test("Bash tool allows PowerShell comparisons, redirects, and here-strings on Windows", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "shell_run");
          return {
            exit_code: 0,
            shell: "powershell",
            platform: "windows",
            profile: "windows-powershell",
            shell_family: "powershell",
            stdout: "ok\n",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            cancelled: false,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 12,
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "codex",
    runtimePlatform: "windows",
  });
  const commands = [
    "$value = 3; if ($value -lt 5) { Write-Output 'ok' }",
    "Get-Content '.\\input.txt' > '.\\output.txt'; Write-Error 'note' 2>> '.\\errors.log'",
    'python -c "print(\'ok\')"',
    "Write-Output \"python - <<'PY'\"",
    "# python - <<'PY'\nWrite-Output 'ok'",
    "<#\npython - <<'PY'\n#>\nWrite-Output 'ok'",
    "$script = @'\npython - <<'PY'\nprint('ready')\nPY\n'@\nWrite-Output $script",
    '$sql = @"\nselect \'value <<EOF\';\n"@\nWrite-Output $sql',
  ];

  for (const command of commands) {
    const result = await bundle.executeToolCall(createBashCall(command));
    assert.equal(result.isError, false);
  }
  assert.equal(calls.length, commands.length);
});

test("ManagedProcess rejects POSIX heredocs before invoking the Windows backend", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    runtimePlatform: "windows",
  });
  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "managed-start-heredoc",
    name: "ManagedProcess",
    arguments: {
      action: "start",
      command: "python <<EOF\nprint('ready')\nEOF",
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /POSIX heredoc syntax/);
  assert.deepEqual(calls, []);
});

function createWindowsFailureLoader(
  shellFamily,
  shell,
  stderr = "export : The term 'export' is not recognized",
) {
  return createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          assert.equal(command, "shell_run");
          return {
            exit_code: 1,
            shell,
            platform: "windows",
            profile: shellFamily === "posix" ? "windows-git-bash" : "windows-powershell",
            shell_family: shellFamily,
            stdout: "",
            stderr,
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            cancelled: false,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 12,
          };
        },
      },
    },
  });
}

test("Bash tool rewrites POSIX syntax hints for native Windows PowerShell", async () => {
  const loader = createWindowsFailureLoader("powershell", "powershell");
  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    runtimePlatform: "windows",
  });

  const result = await bundle.executeToolCall(createBashCall("export NAME=value"));

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ran under native Windows PowerShell/);
  assert.match(result.content[0].text, /PowerShell 5\.1-compatible/);
  assert.doesNotMatch(result.content[0].text, /ARCFORGE_GIT_BASH_PATH/);
});

test("Bash tool does not add a POSIX rewrite hint for an ordinary PowerShell failure", async () => {
  const loader = createWindowsFailureLoader("powershell", "powershell", "boom");
  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    runtimePlatform: "windows",
  });

  const result = await bundle.executeToolCall(createBashCall("Write-Error 'boom'"));

  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /PowerShell 5\.1-compatible/);
});

test("Bash tool allows background commands with detached stdio", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "shell_run");
          return {
            exit_code: 0,
            shell: "zsh",
            stdout: "",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            cancelled: false,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 12,
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
  });

  const result = await bundle.executeToolCall(
    createBashCall("nohup deno run main.ts > /tmp/arcforge-test.log 2>&1 < /dev/null &"),
  );

  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
});

test("ManagedProcess can be omitted from shell tools for non-chat runtimes", async () => {
  const loader = createTsModuleLoader();
  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    managedProcessEnabled: false,
  });

  assert.equal(bundle.tools.some((tool) => tool.name === "ManagedProcess"), false);
  assert.equal(bundle.metadataByName.has("ManagedProcess"), false);

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "managed-disabled",
    name: "ManagedProcess",
    arguments: {
      action: "status",
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown tool/);
});

test("ManagedProcess starts foreground commands through process manager", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "managed_process_start");
          return {
            process: {
              id: "proc-1",
              label: "dev",
              command: args.command,
              cwd: "/repo/app",
              shell: "zsh",
              pid: 123,
              log_path: "/Users/me/.arcforge/process-logs/proc-1.log",
              started_at: 10,
              finished_at: null,
              exit_code: null,
              running: true,
            },
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
  });

  assert.ok(bundle.hasOwnProperty("tools"));
  assert.ok(bundle.tools.some((tool) => tool.name === "ManagedProcess"));

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "managed-start",
    name: "ManagedProcess",
    arguments: {
      action: "start",
      command: "deno run --allow-net main.ts",
      cwd: "app",
      label: "dev",
    },
  });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /ManagedProcess started/);
  assert.match(result.content[0].text, /id=proc-1/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.workdir, "/repo");
  assert.equal(calls[0].args.cwd, "app");
});

test("ManagedProcess rejects nested shell background operators", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    runtimePlatform: "linux",
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "managed-start-bad",
    name: "ManagedProcess",
    arguments: {
      action: "start",
      command: "deno run main.ts &",
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /must be a foreground command/);
  assert.deepEqual(calls, []);
});

test("ManagedProcess allows the PowerShell call operator on Windows", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "managed_process_start");
          return {
            process: {
              id: "proc-windows",
              label: null,
              command: args.command,
              cwd: "/repo",
              shell: "powershell",
              pid: 321,
              log_path: "C:\\logs\\proc-windows.log",
              started_at: 10,
              finished_at: null,
              exit_code: null,
              running: true,
            },
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    runtimePlatform: "windows",
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "managed-start-windows",
    name: "ManagedProcess",
    arguments: {
      action: "start",
      command: "& '.\\server.ps1'",
    },
  });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /ManagedProcess started/);
  assert.equal(calls.length, 1);
});

test("Bash tool marks stdio-open shell responses as errors", async () => {
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          assert.equal(command, "shell_run");
          return {
            exit_code: 0,
            shell: "zsh",
            stdout: "ready\n",
            stderr: "ArcForge warning: command exited, but stdout/stderr remained open after exit.",
            stdout_truncated: false,
            stderr_truncated: true,
            timed_out: false,
            cancelled: false,
            stdio_open_after_exit: true,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 1010,
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
  });

  const result = await bundle.executeToolCall(createBashCall("echo ready"));

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /stdio_open_after_exit: true/);
  assert.match(result.content[0].text, /stdout\/stderr remained open/);
});

test("Bash tool can execute from the fixed Skills root with relative cwd", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "shell_run");
          return {
            exit_code: 0,
            shell: "zsh",
            stdout: "ok\n",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            cancelled: false,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 12,
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.arcforge/skills",
  });

  assert.match(JSON.stringify(bundle.tools[0].parameters), /skill:\/\//);

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "call-skill-bash",
    name: "Bash",
    arguments: {
      cwd: "skill://metaphysics-steward/scripts",
      command: "python3 steward.py --mode qimen",
      timeout_ms: 1000,
    },
  });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /cwd: skill:\/\/metaphysics-steward\/scripts/);
  assert.equal(calls[0].args.workdir, "/repo");
  assert.equal(calls[0].args.cwd, "/Users/me/.arcforge/skills/metaphysics-steward/scripts");
});

test("Bash tool allows enabled Skill scripts by direct absolute path without cd", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "shell_run");
          return {
            exit_code: 0,
            shell: "zsh",
            stdout: "ok\n",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            cancelled: false,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 12,
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.arcforge/skills",
    skillAccessPolicy: {
      allowedSkillNames: ["metaphysics-steward"],
      allowedSkillBaseDirs: ["metaphysics-steward"],
      allowSkillMutation: true,
    },
  });

  const command =
    "python3 /Users/me/.arcforge/skills/metaphysics-steward/scripts/steward.py --mode qimen";
  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "call-absolute-skill-script",
    name: "Bash",
    arguments: {
      command,
      timeout_ms: 1000,
    },
  });

  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.workdir, "/repo");
  assert.equal(calls[0].args.command, command);
});

test("Bash blocks direct Skill execution when the restrictive policy denies mutation", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.arcforge/skills",
    skillAccessPolicy: {
      allowedSkillNames: ["review"],
      allowedSkillBaseDirs: ["review"],
      allowSkillMutation: false,
    },
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-readonly-skill-bash",
    name: "Bash",
    arguments: {
      command: "python3 /Users/me/.arcforge/skills/review/scripts/review.py",
      timeout_ms: 1000,
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Bash command is blocked/);
  assert.match(result.content[0].text, /SKILL_EXECUTION_BLOCKED/);
  assert.match(result.content[0].text, /has not started/);
  assert.doesNotMatch(result.content[0].text, /Enable the Skill in the chat Skills selector/);
  assert.deepEqual(result.details, {
    code: "SKILL_EXECUTION_BLOCKED",
    execution_started: false,
    retryable: false,
  });
  assert.deepEqual(calls, []);
});

test("Bash reports a non-retryable execution denial for enabled Skill cwd on Windows", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });
  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "C:/repo",
    providerId: "claude_code",
    runtimePlatform: "windows",
    skillsRootEnabled: true,
    skillsRootDir: "C:/Users/me/.arcforge/skills",
    skillAccessPolicy: {
      allowedSkillNames: ["data-analyst"],
      allowedSkillBaseDirs: ["data-analyst"],
      allowSkillMutation: false,
    },
  });

  for (const command of [
    "python resolve_row_scope.py --wecom-userid test-user --bot-id test-bot",
    "$env:PYTHONIOENCODING='utf-8'; python resolve_row_scope.py --wecom-userid test-user --bot-id test-bot",
    "python -B resolve_row_scope.py --help",
    "Write-Output readonly",
    "python C:/Users/me/.arcforge/skills/data-analyst/scripts/resolve_row_scope.py",
    "cd ..; python scripts/resolve_row_scope.py",
  ]) {
    const result = await bundle.executeToolCall({
      type: "toolCall",
      id: "blocked-skill-cwd",
      name: "Bash",
      arguments: { cwd: "skill://data-analyst/scripts", command },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.details, {
      code: "SKILL_EXECUTION_BLOCKED",
      execution_started: false,
      retryable: false,
    });
    assert.match(result.content[0].text, /Re-enabling the Skill does not grant execution permission/);
    assert.match(result.content[0].text, /do not reuse cached results/);
  }
  assert.deepEqual(calls, []);

  for (const tool of bundle.tools) {
    assert.match(tool.description, /Running Skill scripts through Bash or ManagedProcess is disabled/);
    assert.doesNotMatch(tool.description, /Running a Skill script: set cwd/);
  }
});

test("Bash keeps authorized Windows Skill cwd execution working", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          return {
            exit_code: 0,
            shell: "powershell",
            stdout: "ok\n",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            cancelled: false,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 1,
          };
        },
      },
    },
  });
  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "C:/repo",
    providerId: "claude_code",
    runtimePlatform: "windows",
    skillsRootEnabled: true,
    skillsRootDir: "C:/Users/me/.arcforge/skills",
    skillAccessPolicy: {
      allowedSkillNames: ["data-analyst"],
      allowedSkillBaseDirs: ["data-analyst"],
      allowSkillMutation: true,
    },
  });
  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "allowed-skill-cwd",
    name: "Bash",
    arguments: { cwd: "skill://data-analyst/scripts", command: "python -B report.py" },
  });
  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "shell_run");
  assert.equal(calls[0].args.cwd, "C:/Users/me/.arcforge/skills/data-analyst/scripts");
  assert.match(bundle.tools[0].description, /Running a Skill script: set cwd/);
  assert.doesNotMatch(bundle.tools[0].description, /Running Skill scripts through Bash or ManagedProcess is disabled/);
});

test("Bash empty Skill allowlist rejects direct absolute Skill execution", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    skillsRootEnabled: false,
    skillsRootDir: "/Users/me/.arcforge/skills",
    skillAccessPolicy: {
      allowedSkillNames: [],
      allowedSkillBaseDirs: [],
      allowSkillMutation: false,
    },
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-empty-skill-allowlist",
    name: "Bash",
    arguments: {
      command: "python3 /Users/me/.arcforge/skills/review/scripts/review.py",
      timeout_ms: 1000,
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /review.*is not enabled/);
  assert.deepEqual(calls, []);
});

test("ManagedProcess applies the same read-only Skill policy before start", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.arcforge/skills",
    skillAccessPolicy: {
      allowedSkillNames: ["review"],
      allowedSkillBaseDirs: ["review"],
      allowSkillMutation: false,
    },
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-readonly-skill-managed-process",
    name: "ManagedProcess",
    arguments: {
      action: "start",
      cwd: "skill://review/scripts",
      command: "python3 review_server.py",
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ManagedProcess command is blocked/);
  assert.match(result.content[0].text, /SKILL_EXECUTION_BLOCKED/);
  assert.deepEqual(result.details, {
    code: "SKILL_EXECUTION_BLOCKED",
    execution_started: false,
    retryable: false,
  });
  assert.deepEqual(calls, []);
});

test("ManagedProcess empty Skill allowlist rejects direct absolute Skill execution", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    skillsRootEnabled: false,
    skillsRootDir: "/Users/me/.arcforge/skills",
    skillAccessPolicy: {
      allowedSkillNames: [],
      allowedSkillBaseDirs: [],
      allowSkillMutation: false,
    },
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-empty-skill-managed-process",
    name: "ManagedProcess",
    arguments: {
      action: "start",
      command: "python3 /Users/me/.arcforge/skills/review/scripts/review_server.py",
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /review.*is not enabled/);
  assert.deepEqual(calls, []);
});

test("Bash tool enforces enabled Skill allowlist for skill cwd", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.arcforge/skills",
    skillAccessPolicy: {
      allowedSkillNames: ["skills-creator"],
      allowedSkillBaseDirs: ["skills-creator"],
    },
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-skill-bash-cwd",
    name: "Bash",
    arguments: {
      cwd: "skill://metaphysics-steward/scripts",
      command: "python3 steward.py --mode qimen",
      timeout_ms: 1000,
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /metaphysics-steward\/scripts.*is not enabled/);
  assert.deepEqual(calls, []);
});

test("Bash tool blocks absolute Skills root access from workspace commands", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.arcforge/skills",
    skillAccessPolicy: {
      allowedSkillNames: ["metaphysics-steward"],
      allowedSkillBaseDirs: ["metaphysics-steward"],
    },
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-absolute-skill-bash",
    name: "Bash",
    arguments: {
      command:
        "cd /Users/me/.arcforge/skills/metaphysics-steward/scripts && python3 steward.py --mode qimen",
      timeout_ms: 1000,
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Bash cannot cd into the fixed Skills root/);
  assert.deepEqual(calls, []);
});

test("Bash tool blocks fixed Skills root access even when Skills are disabled", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-disabled-skill-bash",
    name: "Bash",
    arguments: {
      command: "cat ~/.arcforge/skills/metaphysics-steward/SKILL.md",
      timeout_ms: 1000,
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Bash cannot read or search ~\/\.arcforge\/skills/);
  assert.deepEqual(calls, []);
});

test("Bash tool blocks workspace skills guesses before shell execution", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.arcforge/skills",
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "call-bad-skill-bash",
    name: "Bash",
    arguments: {
      command: "cd skills/metaphysics-steward/scripts && python3 steward.py --mode qimen",
      timeout_ms: 1000,
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /workspace skills\/ guesses/);
  assert.match(result.content[0].text, /cwd to skill:\/\/<enabled-skill>\/scripts/);
  assert.deepEqual(calls, []);
});

test("Bash tool blocks PowerShell reads against the fixed Skills root", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "C:\\repo",
    providerId: "codex",
    runtimePlatform: "windows",
    skillsRootEnabled: true,
    skillsRootDir: "C:\\Users\\me\\.arcforge\\skills",
  });

  const result = await bundle.executeToolCall(
    createBashCall(
      "Get-Content -LiteralPath 'C:\\Users\\me\\.arcforge\\skills\\metaphysics-steward\\SKILL.md'",
    ),
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cat\/Get-Content/);
  assert.deepEqual(calls, []);
});

test("Bash tool blocks PowerShell Set-Location into the fixed Skills root", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "C:\\repo",
    providerId: "codex",
    runtimePlatform: "windows",
    skillsRootEnabled: true,
    skillsRootDir: "C:\\Users\\me\\.arcforge\\skills",
  });

  const result = await bundle.executeToolCall(
    createBashCall(
      "Set-Location -LiteralPath 'C:\\Users\\me\\.arcforge\\skills\\metaphysics-steward\\scripts'",
    ),
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cannot cd into the fixed Skills root/);
  assert.deepEqual(calls, []);
});
