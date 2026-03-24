import fsSync from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const APP_NAME = "copilot-api"

export const PATHS = {
  // Base paths
  HOME_DIR: os.homedir(),
  APP_DIR: path.join(os.homedir(), ".local", "share", APP_NAME),
  GITHUB_TOKEN_PATH: path.join(
    os.homedir(),
    ".local",
    "share",
    APP_NAME,
    "github_token",
  ),

  // Config and logs paths
  CONFIG_DIR: path.join(os.homedir(), ".config", APP_NAME),
  CONFIG_PATH: path.join(os.homedir(), ".config", APP_NAME, "config.json"),
  LOGS_DIR: path.join(os.homedir(), ".config", APP_NAME, "logs"),
  CACHE_DIR: path.join(os.homedir(), ".config", APP_NAME, "cache"),
  TEMP_DIR: path.join(os.tmpdir(), APP_NAME),
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await ensureFile(PATHS.GITHUB_TOKEN_PATH)
}

export function ensureDir(dirPath: string): void {
  if (!fsSync.existsSync(dirPath)) {
    fsSync.mkdirSync(dirPath, { recursive: true })
  }
}

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK)
  } catch {
    await fs.writeFile(filePath, "")
    await fs.chmod(filePath, 0o600)
  }
}
