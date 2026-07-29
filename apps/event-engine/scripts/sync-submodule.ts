import { execSync } from 'child_process';
import { join } from 'path';
import * as readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const prompt = (question: string): Promise<string> => {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
};

async function syncSubmodule() {
  console.log('📦 Syncing submodule changes...\n');

  const parentDir = process.cwd();
  const submoduleDir = join(parentDir, 'src', 'common');

  try {
    // 1. Check submodule status
    process.chdir(submoduleDir);

    const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim();

    if (status) {
      console.log('✏️  Uncommitted changes found in submodule');
      console.log('Status:');
      console.log(execSync('git status --short', { encoding: 'utf8' }));

      const commitMsg = await prompt('Commit message for submodule: ');

      // Stage and commit changes
      execSync('git add -A');
      execSync(`git commit -m "${commitMsg}"`);

      console.log('🚀 Pushing submodule changes...');
      execSync('git push origin main');
      console.log('✅ Pushed submodule changes\n');
    } else {
      console.log('✅ No changes in submodule\n');
    }

    // 2. Get current commit SHA
    const submoduleSHA = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    console.log(`📍 Submodule at commit: ${submoduleSHA}\n`);

    // 3. Go back to parent repo and update reference
    process.chdir(parentDir);
    execSync('git add src/common');
    console.log('✅ Updated parent repo\'s submodule reference\n');

    // 4. Show parent repo status
    console.log('📊 Parent repo status:');
    console.log(execSync('git status --short', { encoding: 'utf8' }));

    console.log('✨ Submodule synced! Ready to commit in parent repo.');

  } catch (error) {
    console.error('❌ Error syncing submodule:', error);
    process.exit(1);
  } finally {
    rl.close();
  }
}

syncSubmodule().catch(console.error);