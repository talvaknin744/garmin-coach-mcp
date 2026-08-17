import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const dataHome =
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
const stateHome =
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");

export const LOCAL_PATHS = {
  browserProfile: join(dataHome, "garmin-coach", "browser-profile"),
  stateDir: join(stateHome, "garmin-coach"),
  lock: join(stateHome, "garmin-coach", "browser.lock"),
  profileContract: join(
    stateHome,
    "garmin-coach",
    "profile-write-contract.json"
  ),
  profileRollback: join(stateHome, "garmin-coach", "profile-rollback.json"),
} as const;

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function writePrivateJson(
  path: string,
  value: unknown
): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function readJsonIfPresent(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function hardenTree(path: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    await chmod(path, 0o600);
    return;
  }
  await chmod(path, 0o700);
  for (const entry of await readdir(path)) await hardenTree(join(path, entry));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class ProcessLock {
  private constructor(
    private readonly path: string,
    private readonly token: string
  ) {}

  static async acquire(path = LOCAL_PATHS.lock): Promise<ProcessLock> {
    await ensurePrivateDir(dirname(path));
    const token = `${process.pid}:${randomUUID()}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const handle = await open(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600
        );
        await handle.writeFile(token);
        await handle.close();
        return new ProcessLock(path, token);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = await readFile(path, "utf8").catch(() => "");
        const pid = Number(owner.split(":", 1)[0]);
        if (Number.isSafeInteger(pid) && processIsAlive(pid)) {
          throw new Error(
            "Garmin browser profile is already in use by another local client"
          );
        }
        if (!owner) {
          throw new Error(
            "Garmin browser profile lock is being acquired by another client"
          );
        }
        const stale = `${path}.stale.${randomUUID()}`;
        try {
          await rename(path, stale);
          await unlink(stale).catch(() => undefined);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw renameError;
          }
        }
      }
    }
    throw new Error("Could not acquire Garmin browser profile lock");
  }

  async release(): Promise<void> {
    const owner = await readFile(this.path, "utf8").catch(() => "");
    if (owner === this.token) await unlink(this.path).catch(() => undefined);
  }
}
