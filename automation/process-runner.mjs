import { spawn } from "node:child_process";

// Never interpolate commands, arguments, output or environment values into errors.
export function processError(code, label = "Child process") {
  const safeLabel = /^[A-Za-z][A-Za-z0-9 -]{0,60}$/.test(label) ? label : "Child process";
  return Object.assign(new Error(`${safeLabel} failed (${code}); output suppressed`), { code });
}

export function runProcess(command, args, {
  cwd, env = process.env, timeoutMs = 45000, maxBuffer = 2 * 1024 * 1024,
  signal, label = "Child process", killGraceMs = 1000, allowedExitCodes = [0],
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(maxBuffer) || maxBuffer < 1) {
    return Promise.reject(processError("INVALID_PROCESS_LIMIT", label));
  }
  if (signal?.aborted) return Promise.reject(processError("ABORTED", label));
  return new Promise((resolve, reject) => {
    let child;
    let deadline;
    let escalation;
    let settled = false;
    let failure;
    let outputBytes = 0;
    const stdout = [];
    const stderr = [];
    const cleanup = () => {
      clearTimeout(deadline);
      clearTimeout(escalation);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(result);
    };
    const killTree = (name) => {
      if (!child?.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, name);
        else child.kill(name);
      } catch { /* The group may already have exited. */ }
    };
    const terminate = (code) => {
      if (failure || settled) return;
      failure = processError(code, label);
      killTree("SIGTERM");
      // Keep escalation even if the group leader exits first: its descendants
      // can still own sockets or inherited pipes. Do not leave them running.
      escalation = setTimeout(() => {
        killTree("SIGKILL");
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        finish(failure);
      }, Math.max(0, Math.min(killGraceMs, 2000)));
    };
    const abort = () => terminate("ABORTED");
    try {
      child = spawn(command, args, {
        cwd, env, shell: false, detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch { finish(processError("SPAWN_FAILED", label)); return; }
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxBuffer) { terminate("OUTPUT_LIMIT"); return; }
      if (!failure) target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", () => {
      if (!failure) finish(processError("SPAWN_FAILED", label));
    });
    child.on("close", (code) => {
      if (failure) return;
      if (!allowedExitCodes.includes(code)) { finish(processError("COMMAND_FAILED", label)); return; }
      finish(null, { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    deadline = setTimeout(() => terminate("TIMEOUT"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
