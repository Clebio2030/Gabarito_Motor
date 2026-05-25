@echo off
setlocal

rem Nome do servico no Windows
set NOME_SERVICO=Gabarito
set NOME_TAREFA=GabaritoUpdater

rem Caminho do node.js
set CAMINHO_NODE=C:\Program Files\nodejs\node.exe

rem Pasta do projeto e backend
set PASTA_PROJETO=C:\Administracao\Gabarito
set PASTA_BACKEND=C:\Administracao\Gabarito\backend

rem Script principal do Node
set SCRIPT_BACKEND=src\server.js

rem Script do atualizador
set SCRIPT_UPDATER=C:\Administracao\Gabarito\updater\updater.js
set HORA_ATUALIZADOR=03:00

rem Caminho do NSSM (versao 64 bits)
set CAMINHO_NSSM=C:\Administracao\Gabarito\nssm\win64\nssm.exe

echo Instalando servico %NOME_SERVICO%...

"%CAMINHO_NSSM%" install %NOME_SERVICO% "%CAMINHO_NODE%" "%PASTA_BACKEND%\%SCRIPT_BACKEND%"
"%CAMINHO_NSSM%" set %NOME_SERVICO% AppDirectory "%PASTA_BACKEND%"
"%CAMINHO_NSSM%" set %NOME_SERVICO% Start SERVICE_AUTO_START

echo Iniciando servico %NOME_SERVICO%...
net start %NOME_SERVICO%

echo.
echo Instalando tarefa agendada %NOME_TAREFA%...
if exist "%SCRIPT_UPDATER%" (
    schtasks /create /f /sc daily /st %HORA_ATUALIZADOR% /tn "%NOME_TAREFA%" /tr "\"%CAMINHO_NODE%\" \"%SCRIPT_UPDATER%\"" /ru SYSTEM
) else (
    echo [AVISO] Arquivo do updater nao encontrado:
    echo         %SCRIPT_UPDATER%
    echo         A tarefa do atualizador nao foi criada.
)

echo.
echo Servico %NOME_SERVICO% instalado e iniciado.
echo Atualizador diario configurado em %HORA_ATUALIZADOR%.
echo Verifique em Servicos do Windows e no Agendador de Tarefas.
echo.
pause
endlocal
