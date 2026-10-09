@echo off
cd /d "%~dp0\..\.."
node deployment\cli.mjs start
pause
