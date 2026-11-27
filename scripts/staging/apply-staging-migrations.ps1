<#
  STAGING ONLY. Builds the schema of a NEW, EMPTY staging Supabase project
  exactly as production has it (docs/paymongo-staging.md):

    1. supabase/staging/00-default-privileges.sql (refuses unless public is empty)
    2. every file in supabase/migrations in filename order EXCEPT 34
       (20260902100034_lift_single_clinic_gate, held in production)

  Each file is sent once with `supabase db query --linked --project-ref`
  (the Management API, as production migrations 61-69 were applied). It
  stops at the first failure and never re-runs a file.

  Refuses the production project ref, and refuses to run in a folder whose
  Supabase link points at production (the main checkout). The CLI links the
  folder it runs in, so the link it leaves is removed at the end.

  Run from the repository root of a worktree (not the main checkout):
    powershell -ExecutionPolicy Bypass -File scripts/staging/apply-staging-migrations.ps1 -ProjectRef <staging ref>
#>
param([Parameter(Mandatory = $true)][string]$ProjectRef)

$ErrorActionPreference = 'Stop'
$Production = 'kwsezszstdagzllbyjuk'

if ($ProjectRef -notmatch '^[a-z]{20}$') { throw 'ProjectRef must be a 20-letter Supabase project ref.' }
if ($ProjectRef -eq $Production) { throw 'Refusing: that is the PRODUCTION project.' }

$link = 'supabase/.temp/linked-project.json'
if (Test-Path $link) {
  $linked = (Get-Content $link -Raw | ConvertFrom-Json).ref
  if ($linked -eq $Production) { throw 'Refusing: this folder is linked to PRODUCTION (the main checkout?). Use a worktree.' }
}

$files = @('supabase/staging/00-default-privileges.sql') +
  @(Get-ChildItem supabase/migrations -Filter *.sql | Sort-Object Name |
    Where-Object { $_.Name -notlike '20260902100034_*' } |
    ForEach-Object { "supabase/migrations/$($_.Name)" })

Write-Host "Staging project: $ProjectRef"
Write-Host "Files to apply: $($files.Count) (default privileges + $($files.Count - 1) migrations; 34 skipped)"
$typed = Read-Host 'Type the staging project ref again to continue'
if ($typed -ne $ProjectRef) { throw 'Not confirmed. Nothing was sent.' }

try {
  foreach ($file in $files) {
    Write-Host "-> $file"
    npx supabase@2.121.0 db query --linked --project-ref $ProjectRef -f $file | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Stopped: $file failed (exit $LASTEXITCODE). Fix it before going on; do not re-run applied files." }
  }
  Write-Host 'All files applied. Next: create the staging auth user, then run supabase/staging/seed-synthetic.sql.'
}
finally {
  if (Test-Path 'supabase/.temp') { Remove-Item -Recurse -Force 'supabase/.temp' }
}
