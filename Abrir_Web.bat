@echo off
setlocal

set INDEX_FRONTEND=http://localhost:3001

echo Abrindo painel do Gabarito no navegador...
start "" "%INDEX_FRONTEND%"

endlocal