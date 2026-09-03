// 진짜 VS Code를 내려받아 확장 호스트로 띄우고 그 안에서 index.ts의 run()을 돌린다.
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { runTests } from '@vscode/test-electron';

async function main() {
  const root = path.resolve(__dirname, '../..');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'retype-e2e-'));
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.resolve(__dirname, 'index'),
      launchArgs: [workspace, '--disable-extensions'],
    });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main();
