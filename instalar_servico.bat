@echo off
setlocal

rem --- CONFIGURACAO DINAMICA ---
rem Pega a pasta onde este script esta (removendo a ultima barra)
set "BASE_DIR=%~dp0"
set "BASE_DIR=%BASE_DIR:~0,-1%"

rem Nome do servico no Windows (Aceita argumento %1 ou usa Gabarito)
if "%~1"=="" (set "NOME_SERVICO=Gabarito") else (set "NOME_SERVICO=%~1")

rem Nome da tarefa agendada (Aceita argumento %2 ou usa GabaritoUpdater)
if "%~2"=="" (set "NOME_TAREFA=%NOME_SERVICO%Updater") else (set "NOME_TAREFA=%~2")

rem Caminho do node.js (Tenta padrao, senao busca no PATH)
set "CAMINHO_NODE=C:\Program Files\nodejs\node.exe"
if not exist "%CAMINHO_NODE%" (
    for /f "delims=" %%i in ('where node.exe 2^>nul') do set "CAMINHO_NODE=%%i"
)

if not exist "%CAMINHO_NODE%" (
    echo [ERRO] Node.exe nao encontrado. Instale o Node.js primeiro.
    pause
    exit /b 1
)

rem Pasta do projeto e backend
set "PASTA_PROJETO=%BASE_DIR%"
set "PASTA_BACKEND=%BASE_DIR%\backend"

rem Script principal do Node
set "SCRIPT_BACKEND=src\server.js"

rem Script do atualizador
set "SCRIPT_UPDATER=%BASE_DIR%\updater\updater.js"
set "HORA_ATUALIZADOR=19:00"

rem Caminho do NSSM
set "CAMINHO_NSSM=%BASE_DIR%\nssm\win64\nssm.exe"
if not exist "%CAMINHO_NSSM%" (
    set "CAMINHO_NSSM=%BASE_DIR%\nssm\win32\nssm.exe"
)

echo.
echo ==================================================
echo INSTALANDO: %NOME_SERVICO%
echo PASTA: %PASTA_PROJETO%
echo ==================================================
echo.

rem Remove se ja existir (para garantir recriacao com paths certos)
"%CAMINHO_NSSM%" stop "%NOME_SERVICO%" >nul 2>&1
"%CAMINHO_NSSM%" remove "%NOME_SERVICO%" confirm >nul 2>&1

echo Registrando servico no Windows...
"%CAMINHO_NSSM%" install "%NOME_SERVICO%" "%CAMINHO_NODE%" "%PASTA_BACKEND%\%SCRIPT_BACKEND%"
"%CAMINHO_NSSM%" set "%NOME_SERVICO%" AppDirectory "%PASTA_BACKEND%"
"%CAMINHO_NSSM%" set "%NOME_SERVICO%" DisplayName "%NOME_SERVICO% (Motor)"
"%CAMINHO_NSSM%" set "%NOME_SERVICO%" Description "Gabarito - Sincronizacao de dados gerente para nuvem"
"%CAMINHO_NSSM%" set "%NOME_SERVICO%" Start SERVICE_AUTO_START

echo Iniciando servico %NOME_SERVICO%...
net start "%NOME_SERVICO%"

echo.
echo ==================================================
echo INSTALANDO TAREFA AGENDADA: %NOME_TAREFA%
echo ==================================================
echo.

if exist "%SCRIPT_UPDATER%" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$action   = New-ScheduledTaskAction -Execute '\"%CAMINHO_NODE%\"' -Argument '\"%SCRIPT_UPDATER%\"';" ^
        "$trigger  = New-ScheduledTaskTrigger -Daily -At '%HORA_ATUALIZADOR%';" ^
        "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;" ^
        "$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest;" ^
        "Register-ScheduledTask -TaskName '%NOME_TAREFA%' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null;" ^
        "Write-Host 'Tarefa agendada criada com sucesso.'"
) else (
    echo [AVISO] Arquivo do updater nao encontrado em: %SCRIPT_UPDATER%
)

echo.
echo Processo concluido!
echo.
pause
endlocal
