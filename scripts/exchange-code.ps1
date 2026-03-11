param(
  [Parameter(Mandatory=$true)]
  [string]$Code
)

npx tsx .\src\scripts\exchangeCodeCli.ts --code "$Code"
