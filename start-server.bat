@echo off
cd /d "%~dp0"
echo Serving from: %CD%
echo Open in browser: http://localhost:8000
echo Press Ctrl+C to stop.
echo.
python -m http.server 8000
pause
