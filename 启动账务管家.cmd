@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 账务管家局域网服务
node server.js
pause
