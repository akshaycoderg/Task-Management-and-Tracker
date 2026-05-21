param(
  [string]$Repo = "akshaycoderg/Task-Management-and-Tracker",
  [string]$Branch = "main",
  [string]$CommitMessage = "Initial task tracker app",
  [string]$Token = ""
)

$ErrorActionPreference = "Stop"

$tokenValue = $Token
if (-not $tokenValue) {
  $tokenValue = $env:GITHUB_TOKEN
}

if (-not $tokenValue) {
  $tokenValue = $env:GH_TOKEN
}

if (-not $tokenValue) {
  $secureToken = Read-Host "Paste a GitHub token with Contents: Read and write permission" -AsSecureString
  $tokenValue = [System.Net.NetworkCredential]::new("", $secureToken).Password
}

if (-not $tokenValue) {
  throw "A GitHub token is required."
}

$headers = @{
  Authorization = "Bearer $tokenValue"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$files = @(
  ".gitignore",
  ".env.example",
  "package.json",
  "railway.json",
  "README.md",
  "src/server.js",
  "public/index.html",
  "public/styles.css",
  "public/app.js",
  "scripts/publish-to-github.ps1"
)

function Invoke-GitHubJson {
  param(
    [string]$Method,
    [string]$Uri,
    [object]$Body = $null
  )

  $params = @{
    Method = $Method
    Uri = $Uri
    Headers = $headers
  }

  if ($null -ne $Body) {
    $params.Body = ($Body | ConvertTo-Json -Depth 20)
    $params.ContentType = "application/json"
  }

  Invoke-RestMethod @params
}

function Get-RemoteFileSha {
  param([string]$Path)

  try {
    $encodedPath = $Path -replace "\\", "/"
    $encodedPath = [System.Uri]::EscapeDataString($encodedPath).Replace("%2F", "/")
    $remote = Invoke-GitHubJson `
      -Method "Get" `
      -Uri "https://api.github.com/repos/$Repo/contents/$encodedPath`?ref=$Branch"
    return $remote.sha
  } catch {
    return $null
  }
}

foreach ($file in $files) {
  $fullPath = Join-Path $root $file
  $bytes = [System.IO.File]::ReadAllBytes($fullPath)
  $content = [Convert]::ToBase64String($bytes)
  $path = $file.Replace("\", "/")
  $sha = Get-RemoteFileSha -Path $path

  $body = @{
    message = $CommitMessage
    content = $content
    branch = $Branch
  }

  if ($sha) {
    $body.sha = $sha
  }

  $encodedPath = [System.Uri]::EscapeDataString($path).Replace("%2F", "/")
  try {
    Invoke-GitHubJson `
      -Method "Put" `
      -Uri "https://api.github.com/repos/$Repo/contents/$encodedPath" `
      -Body $body | Out-Null
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -eq 404) {
      $body.Remove("branch")
      Invoke-GitHubJson `
        -Method "Put" `
        -Uri "https://api.github.com/repos/$Repo/contents/$encodedPath" `
        -Body $body | Out-Null
    } else {
      throw
    }
  }

  Write-Host "Uploaded $path"
}

Write-Host "Published $Repo@$Branch"
Write-Host "URL: https://github.com/$Repo"
