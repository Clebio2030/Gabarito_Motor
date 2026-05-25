@echo off
setlocal enabledelayedexpansion
title Gabarito - Criacao de Views no Firebird

echo.
echo  +----------------------------------------------------------+
echo  ^|  GABARITO - Criacao de Views no Firebird                 ^|
echo  ^|  Execute este script apenas na PRIMEIRA implantacao.     ^|
echo  +----------------------------------------------------------+
echo.

rem Caminho base do projeto
set "PROJETO=%~dp0"
set "ENV_FILE=%PROJETO%backend\.env"
set "SQL_FILE=%PROJETO%sql\criar_views_gabarito.sql"

rem Verifica se o .env existe
if not exist "%ENV_FILE%" (
    echo  [ERRO] Arquivo .env nao encontrado em:
    echo         %ENV_FILE%
    echo.
    echo  Execute o instalador.bat primeiro.
    goto :FIM_ERRO
)

rem Verifica se o SQL existe
if not exist "%SQL_FILE%" (
    echo  [ERRO] Script SQL nao encontrado em:
    echo         %SQL_FILE%
    goto :FIM_ERRO
)

rem Le variaveis do .env
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    if /i "%%A"=="FB_HOST"     set "FB_HOST=%%B"
    if /i "%%A"=="FB_PORT"     set "FB_PORT=%%B"
    if /i "%%A"=="FB_DATABASE" set "FB_DATABASE=%%B"
    if /i "%%A"=="FB_USER"     set "FB_USER=%%B"
    if /i "%%A"=="FB_PASSWORD" set "FB_PASSWORD=%%B"
    if /i "%%A"=="FB_CHARSET"  set "FB_CHARSET=%%B"
)

rem Valores padrao
if not defined FB_HOST     set "FB_HOST=localhost"
if not defined FB_PORT     set "FB_PORT=3050"
if not defined FB_USER     set "FB_USER=SYSDBA"
if not defined FB_PASSWORD set "FB_PASSWORD=masterkey"
if not defined FB_CHARSET  set "FB_CHARSET=WIN1252"

echo  Configuracao lida do .env:
echo    Host     : %FB_HOST%
echo    Porta    : %FB_PORT%
echo    Banco    : %FB_DATABASE%
echo    Usuario  : %FB_USER%
echo    Charset  : %FB_CHARSET%
echo.

rem Procura isql.exe
set "ISQL="

for %%D in (
    "C:\Program Files\Firebird\Firebird_5_0\isql.exe"
    "C:\Program Files\Firebird\Firebird_4_0\isql.exe"
    "C:\Program Files\Firebird\Firebird_3_0\isql.exe"
    "C:\Program Files\Firebird\Firebird_2_5\bin\isql.exe"
    "C:\Program Files\Firebird\Firebird_2_5\isql.exe"
    "C:\Program Files (x86)\Firebird\Firebird_5_0\isql.exe"
    "C:\Program Files (x86)\Firebird\Firebird_4_0\isql.exe"
    "C:\Program Files (x86)\Firebird\Firebird_3_0\isql.exe"
    "C:\Program Files (x86)\Firebird\Firebird_2_5\bin\isql.exe"
    "C:\Program Files (x86)\Firebird\Firebird_2_5\isql.exe"
) do (
    if not defined ISQL (
        if exist %%D set "ISQL=%%~D"
    )
)

rem Fallback: tenta isql no PATH
if not defined ISQL (
    where isql.exe >nul 2>&1
    if !ERRORLEVEL!==0 set "ISQL=isql.exe"
)

if not defined ISQL goto :ISQL_NAO_ENCONTRADO

echo  ISQL encontrado em:
echo    %ISQL%
echo.

rem Confirmacao antes de executar
echo  ATENCAO: Este script vai criar ou recriar as views:
echo    - GABARITO_EMPRESAS
echo    - GABARITO_FATURAMENTO_MENSAL
echo.
set /p "CONFIRMA=  Deseja continuar? [S/N]: "
if /i not "%CONFIRMA%"=="S" goto :FIM_CANCELADO

set "LOGTEMP=%PROJETO%sql\isql_output.tmp"

echo.
echo  Executando script SQL...
echo  ----------------------------------------------------------

"%ISQL%" -user "%FB_USER%" -password "%FB_PASSWORD%" -ch %FB_CHARSET% %FB_HOST%/%FB_PORT%:%FB_DATABASE% -i "%SQL_FILE%" > "%LOGTEMP%" 2>&1

type "%LOGTEMP%"

echo  ----------------------------------------------------------
echo.

rem Verifica sucesso: busca a mensagem de confirmacao do SQL no output
findstr /i "Views criadas" "%LOGTEMP%" >nul 2>&1
if "!ERRORLEVEL!" == "0" (
    del "%LOGTEMP%" >nul 2>&1
    goto :FIM_OK
)

rem Se nao achou a mensagem de sucesso, houve erro
goto :FIM_SQL_ERRO


:ISQL_NAO_ENCONTRADO
echo  +----------------------------------------------------------+
echo  ^|  [ERRO] isql.exe nao encontrado!                        ^|
echo  +----------------------------------------------------------+
echo.
echo  O isql.exe e a ferramenta de linha de comando do Firebird.
echo  Verifique se o Firebird esta instalado no servidor.
echo.
echo  Se ja estiver instalado, edite este .bat e defina o caminho:
echo    Procure "set ISQL=" e coloque o caminho completo.
echo.
pause
goto :EOF

:FIM_OK
echo  +----------------------------------------------------------+
echo  ^|  [OK] Views criadas com sucesso!                        ^|
echo  ^|                                                         ^|
echo  ^|  Proximos passos:                                       ^|
echo  ^|   1. Abra backend\.env e preencha GABARITO_TOKEN        ^|
echo  ^|   2. Execute instalar_servico.bat                       ^|
echo  ^|   3. Acesse http://localhost:3001 para confirmar        ^|
echo  +----------------------------------------------------------+
echo.
pause
goto :EOF

:FIM_SQL_ERRO
echo  +----------------------------------------------------------+
echo  ^|  [ERRO] Falha ao executar o script SQL!                 ^|
echo  +----------------------------------------------------------+
echo.
echo  Verifique:
echo    - Firebird acessivel em %FB_HOST%:%FB_PORT%
echo    - Usuario/senha corretos no .env
echo    - Caminho do banco: %FB_DATABASE%
echo.
pause
goto :EOF

:FIM_CANCELADO
echo.
echo  Operacao cancelada.
echo.
pause
goto :EOF

:FIM_ERRO
echo.
pause
goto :EOF