# Ralph - Long-running AI agent loop for Claude Code
# Usage: .\ralph.ps1 [-MaxIterations <n>]
# Example: .\ralph.ps1 -MaxIterations 20

param(
    [int]$MaxIterations = 10
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PrdFile = Join-Path $ScriptDir "prd.json"
$ProgressFile = Join-Path $ScriptDir "progress.txt"
$ArchiveDir = Join-Path $ScriptDir "archive"
$LastBranchFile = Join-Path $ScriptDir ".last-branch"
$PromptFile = Join-Path $ScriptDir "prompt.md"

# Archive previous run if branch changed
if ((Test-Path $PrdFile) -and (Test-Path $LastBranchFile)) {
    try {
        $prdContent = Get-Content $PrdFile -Raw | ConvertFrom-Json
        $CurrentBranch = $prdContent.branchName
        $LastBranch = Get-Content $LastBranchFile -Raw -ErrorAction SilentlyContinue
        $LastBranch = $LastBranch.Trim()

        if ($CurrentBranch -and $LastBranch -and ($CurrentBranch -ne $LastBranch)) {
            # Archive the previous run
            $Date = Get-Date -Format "yyyy-MM-dd"
            $FolderName = $LastBranch -replace "^ralph/", ""
            $ArchiveFolder = Join-Path $ArchiveDir "$Date-$FolderName"

            Write-Host "Archiving previous run: $LastBranch" -ForegroundColor Yellow
            New-Item -ItemType Directory -Path $ArchiveFolder -Force | Out-Null

            if (Test-Path $PrdFile) { Copy-Item $PrdFile $ArchiveFolder }
            if (Test-Path $ProgressFile) { Copy-Item $ProgressFile $ArchiveFolder }

            Write-Host "   Archived to: $ArchiveFolder" -ForegroundColor Gray

            # Reset progress file for new run
            @"
# Ralph Progress Log
Started: $(Get-Date)
---
"@ | Set-Content $ProgressFile
        }
    }
    catch {
        Write-Host "Warning: Could not check branch change: $_" -ForegroundColor Yellow
    }
}

# Track current branch
if (Test-Path $PrdFile) {
    try {
        $prdContent = Get-Content $PrdFile -Raw | ConvertFrom-Json
        if ($prdContent.branchName) {
            $prdContent.branchName | Set-Content $LastBranchFile
        }
    }
    catch {
        Write-Host "Warning: Could not read PRD file: $_" -ForegroundColor Yellow
    }
}

# Initialize progress file if it doesn't exist
if (-not (Test-Path $ProgressFile)) {
    @"
# Ralph Progress Log
Started: $(Get-Date)
---
"@ | Set-Content $ProgressFile
}

# Check that prompt.md exists
if (-not (Test-Path $PromptFile)) {
    Write-Host "Error: prompt.md not found at $PromptFile" -ForegroundColor Red
    Write-Host "Please create the prompt file first." -ForegroundColor Red
    exit 1
}

# Check that prd.json exists
if (-not (Test-Path $PrdFile)) {
    Write-Host "Error: prd.json not found at $PrdFile" -ForegroundColor Red
    Write-Host "Please create a PRD first using: /prd <feature description>" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Starting Ralph - Max iterations: $MaxIterations" -ForegroundColor Cyan
Write-Host ""

for ($i = 1; $i -le $MaxIterations; $i++) {
    Write-Host ""
    Write-Host "=======================================================" -ForegroundColor Magenta
    Write-Host "  Ralph Iteration $i of $MaxIterations" -ForegroundColor Magenta
    Write-Host "=======================================================" -ForegroundColor Magenta
    Write-Host ""

    # Read the prompt content
    $PromptContent = Get-Content $PromptFile -Raw

    # Run claude with the prompt as an argument (not piped to stdin)
    # Using --dangerously-skip-permissions to allow autonomous operation
    # The -p flag enables print mode (non-interactive)
    try {
        # Use Start-Process to capture output properly, or invoke directly
        $Output = & claude --dangerously-skip-permissions -p $PromptContent 2>&1

        # Display output to console
        $Output | ForEach-Object { Write-Host $_ }
    }
    catch {
        Write-Host "Error running Claude: $_" -ForegroundColor Red
        $Output = ""
    }

    # Check for completion signal
    if ($Output -match "<promise>COMPLETE</promise>") {
        Write-Host ""
        Write-Host "Ralph completed all tasks!" -ForegroundColor Green
        Write-Host "Completed at iteration $i of $MaxIterations" -ForegroundColor Green
        exit 0
    }

    # Check remaining tasks
    try {
        $prd = Get-Content $PrdFile -Raw | ConvertFrom-Json
        $remaining = ($prd.userStories | Where-Object { $_.passes -eq $false }).Count
        Write-Host ""
        Write-Host "Iteration $i complete. $remaining tasks remaining. Continuing..." -ForegroundColor Cyan
    }
    catch {
        Write-Host "Iteration $i complete. Continuing..." -ForegroundColor Cyan
    }

    Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "Ralph reached max iterations ($MaxIterations) without completing all tasks." -ForegroundColor Yellow
Write-Host "Check $ProgressFile for status." -ForegroundColor Yellow
exit 1
