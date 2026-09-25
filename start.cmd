@echo off
rem Double-click to start auto-pr-review. Pass --dry-run to review without posting.
cd /d "%~dp0"
node src\index.js %*
