@echo off
setlocal enabledelayedexpansion

rem --- CONFIGURACAO DINAMICA ---
set "BASE_DIR=%~dp0"
if "%BASE_DIR:~-1%"=="\" set "BASE_DIR=%BASE_DIR:~0,-1%"

set "CAMINHO_NSSM=%BASE_DIR%\nssm\win64\nssm.exe"
if not exist "%CAMINHO_NSSM%" (
    set "CAMINHO_NSSM=%BASE_DIR%\nssm\win32\nssm.exe"
)

rem Nome do servico (Argumento %1)
set "NOME_SERVICO=%~1"

rem Se não passou argumento, PERGUNTA ao usuário
if "!NOME_SERVICO!"=="" (
    echo.
    echo ##################################################
    echo #           REMOVER SERVICO GABARITO             #
    echo ##################################################
    echo.
    set /p NOME_SERVICO="Digite o NOME do servico que deseja remover [ou Enter para 'Gabarito']: "
)

if "!NOME_SERVICO!"=="" (set "NOME_SERVICO=Gabarito")

set "NOME_TAREFA=%NOME_SERVICO%Updater"

echo.
echo ==================================================
echo REMOVENDO: !NOME_SERVICO!
echo ==================================================
echo.

echo Parando o servico !NOME_SERVICO!...
"%CAMINHO_NSSM%" stop "!NOME_SERVICO!" >nul 2>&1

echo Removendo o servico !NOME_SERVICO!...
"%CAMINHO_NSSM%" remove "!NOME_SERVICO!" confirm

echo Removendo tarefa agendada !NOME_TAREFA!...
schtasks /delete /f /tn "!NOME_TAREFA!" >nul 2>&1

echo.
echo Remocao concluida para: !NOME_SERVICO!
echo.
pause
endlocal
