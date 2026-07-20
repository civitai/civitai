import { writeFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

const hookContent = `#!/bin/sh
# Auto-sync parent repository when committing in submodule

# Check if we're in the submodule directory
if [ -f "../../.gitmodules" ] && grep -q "src/common" "../../.gitmodules" 2>/dev/null; then
    # We're in the submodule, update parent's reference
    cd ../..
    git add src/common 2>/dev/null || true

    # Check if there's actually a change to the submodule reference
    if git diff --cached --name-only | grep -q "src/common"; then
        echo "✅ Parent repository's submodule reference updated automatically"
    fi
fi
`;

function getSubmoduleGitDir(): string {
  // Submodules have a .git file (not directory) that points to the real git directory
  const gitFile = join(process.cwd(), 'src', 'common', '.git');

  if (existsSync(gitFile)) {
    const content = readFileSync(gitFile, 'utf8').trim();
    // Format is usually: "gitdir: ../../.git/modules/src/common"
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (match) {
      const gitDir = match[1];
      // Resolve the path relative to the submodule
      return resolve(join(process.cwd(), 'src', 'common'), gitDir);
    }
  }

  // Fallback to default location
  return join(process.cwd(), '.git', 'modules', 'src', 'common');
}

function installGitHooks() {
  const parentHooksDir = join(process.cwd(), '.git', 'hooks');
  const submoduleGitDir = getSubmoduleGitDir();
  const submoduleHooksDir = join(submoduleGitDir, 'hooks');

  // Ensure hook directories exist
  [parentHooksDir, submoduleHooksDir].forEach(dir => {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  });

  // Install post-commit hook in submodule
  const submoduleHookPath = join(submoduleHooksDir, 'post-commit');

  try {
    writeFileSync(submoduleHookPath, hookContent);

    // Make executable on Unix-like systems
    if (process.platform !== 'win32') {
      chmodSync(submoduleHookPath, 0o755);
    }

    console.log('✅ Git hook installed successfully in submodule');
    console.log('📍 Location:', submoduleHookPath);
    console.log('\n🎯 Now when you commit in src/common, the parent repo will automatically update its reference');

    // On Windows, we need to ensure the hook works with Git Bash
    if (process.platform === 'win32') {
      console.log('\n⚠️  Note for Windows: Make sure you\'re using Git Bash or WSL for the hooks to work properly');
    }
  } catch (error) {
    console.error('❌ Failed to install git hook:', error);
    process.exit(1);
  }
}

// Check if submodule is initialized
try {
  execSync('git submodule status src/common', { stdio: 'pipe' });
} catch {
  console.error('❌ Submodule not initialized. Run: git submodule update --init');
  process.exit(1);
}

installGitHooks();