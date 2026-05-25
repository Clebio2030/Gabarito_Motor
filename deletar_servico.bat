@echo off
setlocal

rem Nome do servico no Windows
set NOME_SERVICO=Gabarito
set NOME_TAREFA=GabaritoUpdater

rem Caminho do NSSM (versao 64 bits)
set CAMINHO_NSSM=C:\Administracao\Gabarito\nssm\win64\nssm.exe

echo Parando o servico %NOME_SERVICO%...
"%CAMINHO_NSSM%" stop %NOME_SERVICO%

echo Removendo o servico %NOME_SERVICO%...
"%CAMINHO_NSSM%" remove %NOME_SERVICO% confirm

echo Removendo tarefa agendada %NOME_TAREFA%...
schtasks /delete /f /tn "%NOME_TAREFA%" >nul 2>&1

echo.
echo Servico e atualizador removidos com sucesso.
echo.
pause
endlocal
