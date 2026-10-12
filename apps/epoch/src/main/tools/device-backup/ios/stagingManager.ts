import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function atomicWriteFile(targetPath: string, data: Buffer | string): Promise<void> {
  const parsedPath = path.parse(targetPath);
  const stagingDir = path.join(parsedPath.dir, '.staging');

  await fs.mkdir(stagingDir, { recursive: true });

  const randomSuffix = Math.random().toString(36).slice(2, 8);
  const tempFilePath = path.join(stagingDir, `${parsedPath.name}_${Date.now()}_${randomSuffix}${parsedPath.ext}`);

  try {
    await fs.writeFile(tempFilePath, data);
    await fs.rename(tempFilePath, targetPath);
  } catch (error) {
    await fs.rm(tempFilePath, { force: true }).catch(() => {});
    throw error;
  }
}
