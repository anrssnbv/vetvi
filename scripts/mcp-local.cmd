@echo off
cd /d "%~dp0.."
node --import tsx server/stdio.ts
