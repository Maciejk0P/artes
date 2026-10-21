@echo off
rem claude-health: a health check of your Claude Code setup.
rem
rem   claude-health check            (claude-health --help lists the options)
rem
rem This script and the sh script next to it are the only places in this package that start a
rem program, and they start one: node, with the check. No browser is opened and Claude Code is
rem not started. The check ends with the link to its report and the two lines that continue in
rem Claude Code.
setlocal EnableExtensions DisableDelayedExpansion
rem cmd looks for a program in the working directory before the PATH. Started from inside a
rem repository, this script would run a node.cmd or a where.cmd that the repository ships. The
rem switch below turns that lookup off while this script runs.
set "NoDefaultCurrentDirectoryInExePath=1"
set "here=%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node

node "%here%bin\claude-health.mjs" %*
exit /b %errorlevel%

:no_node
echo claude-health needs Node.js 20 or newer on the PATH. / claude-health potrebuje Node.js 20 alebo novsi v PATH. 1>&2
exit /b 1
