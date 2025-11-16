@echo off
nautus build
pkg -t node18-win-x64 .\dist\main.js
mv main.exe wallpaper-engine-ha-server.exe
echo Done!