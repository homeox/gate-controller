param(
    [switch]$Build,
    [switch]$Reset
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:JAVA_HOME = 'D:\GateAndroidTools\jdk-17'
$env:ANDROID_HOME = 'D:\GateAndroidTools\android-sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:GRADLE_USER_HOME = 'D:\GateAndroidTools\gradle-user-home'
$env:Path = "$env:JAVA_HOME\bin;D:\GateAndroidTools\gradle-8.10.2\bin;$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\emulator;$env:Path"

if ($Build) {
    Push-Location $root
    try {
        gradle assembleDebug
        if ($LASTEXITCODE -ne 0) {
            throw "Android build failed"
        }
    } finally {
        Pop-Location
    }
}

$apk = Join-Path $root 'app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path -LiteralPath $apk)) {
    throw "APK not found. Run: .\install-phone.ps1 -Build"
}

adb devices
if ($LASTEXITCODE -ne 0) {
    throw "No Android device available"
}
if ($Reset) {
    adb uninstall com.rkiwi.gate
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'App was not installed yet, continuing.'
    }
}
adb install -r $apk
if ($LASTEXITCODE -ne 0) {
    throw "APK install failed"
}

Write-Host ''
Write-Host 'Gate app installed.'
Write-Host 'Add the Gate app icon to the home screen if Android does not do it automatically.'
Write-Host 'Tap the app icon to send one gate pulse.'
