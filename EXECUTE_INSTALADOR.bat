@echo off
setlocal enabledelayedexpansion
title Gabarito - Instalador Completo
:: Define cor PADRAO (Branco sobre Preto)
color 07

:: ==================================================
:: VERIFICACAO DE ADMINISTRADOR
:: ==================================================
net session >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo.
    echo ##################################################
    echo #                                                #
    echo #      ERRO: PRIVILEGIOS INSUFICIENTES           #
    echo #                                                #
    echo ##################################################
    echo.
    echo O instalador precisa ser executado como ADMINISTRADOR!
    echo.
    echo Por favor, clique com o botao direito no arquivo e escolha:
    echo "Executar como administrador"
    echo.
    pause
    exit /b
)

:: ==================================================
:: CONFIGURACAO DO TERMINAL (Aumentar Fonte)
:: ==================================================
powershell -Command "$Host.UI.RawUI.FontSize = 14; $Host.UI.RawUI.WindowSize = New-Object System.Management.Automation.Host.Size(120, 40)" >nul 2>&1
mode con: cols=120 lines=40 >nul 2>&1

:: Cabecalho Principal em Verde
color 0A
echo.
echo ##################################################
echo #                                                #
echo #       GABARITO - INSTALADOR AUTOMATIZADO        #
echo #                                                #
echo ##################################################
echo.
:: Volta para Branco
color 07

:: Garante que o script rode no diretorio onde o arquivo esta
cd /d "%~dp0"

:: --- PASSO 1: NODE.JS ---
if not exist "node.msi" goto SKIP_NODE

:: Cabecalho Verde
color 0A
echo --------------------------------------------------
echo [PASSO 1/6] Instalacao do Node.js
echo --------------------------------------------------
timeout /t 1 >nul
color 07

echo.
echo Encontrado instalador do Node.js (node.msi).
echo Iniciando assistente...
echo Por favor, complete a instalacao na janela que se abriu.
echo.
echo AGUARDANDO TERMINO DA INSTALACAO...

start /wait msiexec /i node.msi

echo.
echo Instalacao do Node.js concluida (ou cancelada pelo usuario).
goto CHECK_NPM

:SKIP_NODE
echo [AVISO] Arquivo 'node.msi' nao encontrado na pasta atual.
echo Pulando instalacao do Node.js...

:CHECK_NPM
:: Cabecalho Verde
color 0A
echo.
echo --------------------------------------------------
echo [PASSO 2/6] Instalando Dependencias do Backend
echo --------------------------------------------------
timeout /t 1 >nul
color 07

echo.
:: Verifica se o npm esta disponivel
call npm -v >nul 2>&1
if %errorlevel% EQU 0 goto INSTALL_DEPS

color 0E
echo.
echo [ATENCAO] O comando 'npm' nao foi reconhecido.
echo Se voce acabou de instalar o Node.js, pode ser necessario
echo reiniciar o computador ou fechar e abrir este script novamente.
echo.
echo Pressione qualquer tecla para tentar continuar mesmo assim...
pause >nul
color 07

:INSTALL_DEPS
if not exist "backend" goto ERROR_NO_BACKEND

cd backend
echo Acessando pasta 'backend'...
echo Executando 'npm install'...
echo (Isso pode levar alguns minutos dependendo da internet...)

call npm install

if %errorlevel% NEQ 0 goto ERROR_INSTALL

echo.
echo [SUCESSO] Dependencias instaladas com sucesso!
goto CONFIG_ENV

:CONFIG_ENV
:: Cabecalho Verde
color 0A
echo.
echo --------------------------------------------------
echo [PASSO 3/6] Configuracao do Ambiente (.env)
echo --------------------------------------------------
timeout /t 1 >nul
color 07

echo.
echo Informe os dados para atualizar o arquivo .env.
echo Deixe em branco para MANTER o valor atual (ou nao alterar).
echo.

:: Coleta dados do usuario
set "FB_HOST_IN="
set /p FB_HOST_IN="FB_HOST (IP SERVIDOR ) [Enter para manter]: "

set "FB_PORT_IN="
set /p FB_PORT_IN="FB_PORT (Porta do Firebird) [Enter para manter]: "

set "FB_DATABASE_IN="
set /p FB_DATABASE_IN="FB_DATABASE (Caminho Banco, copie em Start.in) [Enter para manter]: "

set "GABARITO_TOKEN_IN="
set /p GABARITO_TOKEN_IN="GABARITO_TOKEN (Token de integracao Gabarito) [Enter para manter]: "

:: Prepara variaveis (se vazio, passa string especial EMPTY_VAL)
if "!FB_HOST_IN!"=="" (set "ARG1=EMPTY_VAL") else (set "ARG1=!FB_HOST_IN!")
if "!FB_PORT_IN!"=="" (set "ARG2=EMPTY_VAL") else (set "ARG2=!FB_PORT_IN!")
if "!FB_DATABASE_IN!"=="" (set "ARG3=EMPTY_VAL") else (set "ARG3=!FB_DATABASE_IN!")
if "!GABARITO_TOKEN_IN!"=="" (set "ARG4=EMPTY_VAL") else (set "ARG4=!GABARITO_TOKEN_IN!")

echo.
echo Atualizando .env...

if exist "setup-env.js" (
    node setup-env.js "!ARG1!" "!ARG2!" "!ARG3!" "!ARG4!"
) else (
    echo [ERRO] Script setup-env.js nao encontrado na pasta backend.
    (
        echo FB_HOST=!FB_HOST_IN!
        echo FB_PORT=!FB_PORT_IN!
        echo FB_DATABASE=!FB_DATABASE_IN!
        echo GABARITO_TOKEN=!GABARITO_TOKEN_IN!
    ) >> .env
)

echo.
echo [SUCESSO] Configuracao concluida!

:: Atualizar Config do Atualizador (Padrao)
echo.
echo Atualizando configuracoes do atualizador...
cd /d "%~dp0\updater"
node setup-updater.js "Gabarito" "3001"

cd ..
goto CONFIG_FIREBIRD

:CONFIG_FIREBIRD
:: Cabecalho Verde
color 0A
echo.
echo --------------------------------------------------
echo [PASSO 4/6] Configuracao do Firebird (firebird.conf)
echo --------------------------------------------------
timeout /t 1 >nul
color 07

echo.
echo ATENCAO: Precisamos do caminho OBRIGATORIO da instalacao do Firebird.
echo Onde esta o arquivo firebird.conf?
echo.
echo Exemplo: C:\Program Files\Firebird\Firebird_5_0
echo.

:ASK_FB_PATH
set "FB_PATH="
set /p FB_PATH="Digite o caminho COMPLETO da pasta do Firebird: "

:: Validacao de vazio
if "!FB_PATH!"=="" (
    echo.
    echo [ERRO] O caminho nao pode ficar vazio.
    goto ASK_FB_PATH
)

echo.
echo Verificando: "!FB_PATH!\firebird.conf"...

if not exist "!FB_PATH!\firebird.conf" (
    color 0C
    echo.
    echo ##################################################
    echo #  ERRO: ARQUIVO FIREBIRD.CONF NAO ENCONTRADO    #
    echo ##################################################
    echo.
    echo Caminho invalido: !FB_PATH!
    echo Por favor, verifique onde o Firebird esta instalado.
    echo.
    pause
    color 07
    echo.
    goto ASK_FB_PATH
)

echo.
echo Arquivo encontrado! Fazendo backup e aplicando alteracoes...

:: Cria script PowerShell temporario
set PS_SCRIPT=%TEMP%\fix_firebird_%RANDOM%.ps1
(
echo $path = '!FB_PATH!\firebird.conf'
echo $bkp = $path + '.bak'
echo Copy-Item $path $bkp -Force
echo Write-Host 'Backup criado em: ' $bkp
echo $lines = Get-Content $path
echo $newLines = New-Object System.Collections.Generic.List[string]
echo $modified = $false
echo foreach ($line in $lines^) {
echo   $trimmed = $line.TrimStart^(^)
echo   if ($trimmed -match '^\s*#?\s*AuthServer\s*='^) {
echo     $line = 'AuthServer = Srp256, Srp, Legacy_Auth'
echo     Write-Host 'Configurado: AuthServer = Srp256, Srp, Legacy_Auth'
echo     $modified = $true
echo   }
echo   elseif ($trimmed -match '^\s*#?\s*AuthClient\s*='^) {
echo     $line = 'AuthClient = Srp256, Srp, Legacy_Auth'
echo     Write-Host 'Configurado: AuthClient = Srp256, Srp, Legacy_Auth'
echo     $modified = $true
echo   }
echo   elseif ($trimmed -match '^\s*#?\s*WireCrypt\s*='^) {
echo     $line = 'WireCrypt = Enabled'
echo     Write-Host 'Configurado: WireCrypt = Enabled'
echo     $modified = $true
echo   }
echo   elseif ($trimmed -match '^\s*#\s*RemoteServicePort\s*='^) {
echo     $line = $line -replace '^\s*#\s*', ''
echo     Write-Host 'Descomentado: RemoteServicePort'
echo     $modified = $true
echo   }
echo   $newLines.Add($line^)
echo }
echo if ($modified^) {
echo   [System.IO.File]::WriteAllLines($path, $newLines, [System.Text.Encoding]::Default^)
echo   Write-Host 'Arquivo atualizado com sucesso!'
echo } else {
echo   Write-Host 'Nenhuma alteracao necessaria.'
echo }
) > "%PS_SCRIPT%"

:: Executa o script PowerShell
powershell -ExecutionPolicy Bypass -File "%PS_SCRIPT%"

:: Remove o script temporario
del "%PS_SCRIPT%" >nul 2>&1

echo.
echo [SUCESSO] Firebird configurado.
echo.
echo --------------------------------------------------
echo REINICIAR SERVICO FIREBIRD
echo --------------------------------------------------
echo.
set /p RESTART_FB="Deseja tentar reiniciar o servico do Firebird automaticamente? (S/N): "
if /i "!RESTART_FB!"=="S" (
    echo.
    echo Identificando servico do Firebird...
    
    powershell -Command ^
        "$svc = Get-Service | Where-Object { $_.DisplayName -like '*Firebird*' -or $_.Name -like '*Firebird*' };" ^
        "if ($svc) {" ^
        "  foreach ($s in $svc) {" ^
        "    Write-Host 'Reiniciando servico encontrado:' $s.Name;" ^
        "    Restart-Service -Name $s.Name -Force;" ^
        "    Write-Host 'Servico' $s.Name 'reiniciado com sucesso.';" ^
        "  }" ^
        "} else {" ^
        "  Write-Host 'Nenhum servico do Firebird encontrado automaticamente.';" ^
        "  Write-Host 'Por favor, reinicie manualmente pelo services.msc';" ^
        "}"
)

goto SCRIPT_BANCO

:SCRIPT_BANCO
:: Cabecalho Verde
color 0A
echo.
echo --------------------------------------------------
echo [PASSO 5/6] Scripts de Banco de Dados
echo --------------------------------------------------
timeout /t 1 >nul

color 0C
echo.
echo ##################################################
echo #                                                #
echo #      ATENCAO: CRIANDO VIEWS NO BANCO!!         #
echo #                                                #
echo ##################################################
echo.
echo Executando script de criacao de views no Firebird...
echo.

color 07

:: Executa o script de criacao de views do Gabarito
if exist "criar_views_gabarito.bat" (
    call criar_views_gabarito.bat
) else (
    color 0C
    echo [ERRO] Arquivo 'criar_views_gabarito.bat' nao encontrado.
    color 07
)

goto INSTALAR_SERVICO

:INSTALAR_SERVICO
:: Cabecalho Verde
color 0A
echo.
echo --------------------------------------------------
echo [PASSO 6/6] Instalacao do Servico Windows (Gabarito)
echo --------------------------------------------------
timeout /t 1 >nul
color 07

echo.
echo Executando instalacao do servico e atualizador...
echo.

if exist "instalar_servico.bat" (
    call instalar_servico.bat
) else (
    color 0C
    echo [ERRO] Arquivo 'instalar_servico.bat' nao encontrado!
    color 07
)

goto FIM

:ERROR_INSTALL
color 0C
echo.
echo ##################################################
echo #         ERRO NA INSTALACAO DO NPM              #
echo ##################################################
echo.
cd ..
goto FIM

:ERROR_NO_BACKEND
color 0C
echo.
echo ##################################################
echo #      ERRO: PASTA 'BACKEND' NAO ENCONTRADA      #
echo ##################################################
echo.
goto FIM

:FIM
echo.
color 0A
echo ==================================================
echo          PROCESSO FINALIZADO COM SUCESSO
echo ==================================================
echo.
echo Pressione qualquer tecla para sair...
pause >nul
endlocal





