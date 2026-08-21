@echo off
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\chrome-debug-profile"
echo Chrome launched. Sign in to YouTube as @Scenteno in the window that opened.
