@echo off
setlocal

rem --- CONFIGURACAO DINAMICA ---
set "BASE_DIR=%~dp0"
set "BASE_DIR=%BASE_DIR:~0,-1%"

if "%~1"=="" (set "NOME_SERVICO=Gabarito") else (set "NOME_SERVICO=%~1")
if "%~2"=="" (set "NOME_TAREFA=%NOME_SERVICO%Updater") else (set "NOME_TAREFA=%~2")

set "CAMINHO_NSSM=%BASE_DIR%\nssm\win64\nssm.exe"
if not exist "%CAMINHO_NSSM%" (
    set "CAMINHO_NSSM=%BASE_DIR%\nssm\win32\nssm.exe"
)

echo.
echo ==================================================
echo REMOVENDO: %NOME_SERVICO%
echo ==================================================
echo.

echo Parando o servico %NOME_SERVICO%...
"%CAMINHO_NSSM%" stop "%NOME_SERVICO%" >nul 2>&1

echo Removendo o servico %NOME_SERVICO%...
"%CAMINHO_NSSM%" remove "%NOME_SERVICO%" confirm

echo Removendo tarefa agendada %NOME_TAREFA%...
schtasks /delete /f /tn "%NOME_TAREFA%" >nul 2>&1

echo.
echo Remocao concluida.
echo.
pause
endlocal
