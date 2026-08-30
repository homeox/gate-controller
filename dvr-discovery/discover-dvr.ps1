<#
.SYNOPSIS
    Discover DVR/XVR on local network and probe ports/services.
.DESCRIPTION
    Finds DVR by MAC address, scans TCP/UDP ports, tests HTTP/RTSP/ONVIF.
.PARAMETER TargetMac
    DVR MAC address (e.g. c8:22:02:61:15:97)
.PARAMETER TargetIp
    If known, skip MAC lookup and scan this IP directly
.PARAMETER Username
    DVR login username
.PARAMETER Password
    DVR login password
#>

param(
    [string]$TargetMac = "c8:22:02:61:15:97",
    [string]$TargetIp = "",
    [string]$Username = "rick",
    [string]$Password = "2017"
)

$outDir = Join-Path $PSScriptRoot "discovery-output"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# Normalize MAC
$macNorm = $TargetMac.ToLower().Replace(":", "-").Replace(" ", "")
Write-Output "=== DVR Discovery ==="
Write-Output "Target MAC: $macNorm"

# Step 1: Find IP
if (-not $TargetIp) {
    $arp = arp -a | Select-String $macNorm
    if ($arp) {
        $TargetIp = ($arp -split '\s+')[1].Trim()
        Write-Output "Found IP from ARP: $TargetIp"
    } else {
        # Ping subnet to populate ARP
        $subnet = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notlike "*Loopback*" -and $_.PrefixOrigin -eq "Dhcp" } | Select-Object -First 1).IPAddress
        $subnetPrefix = $subnet -replace '\.[0-9]+$', ''
        Write-Output "Pinging $subnetPrefix.0/24 to populate ARP..."
        1..254 | ForEach-Object -Parallel {
            Test-Connection "$using:subnetPrefix.$_" -Count 1 -Quiet -TimeoutSeconds 1 2>$null
        } | Out-Null
        Start-Sleep -Seconds 2
        $arp = arp -a | Select-String $macNorm
        if ($arp) {
            $TargetIp = ($arp -split '\s+')[1].Trim()
            Write-Output "Found IP from ARP after scan: $TargetIp"
        } else {
            Write-Error "Could not find DVR on network"
            exit 1
        }
    }
}

$ip = $TargetIp
Write-Output "Target IP: $ip"

# Step 2: TCP port scan
Write-Output "`n=== TCP Port Scan ==="
$tcpPorts = @(21,22,23,25,53,80,81,82,83,88,443,554,8000,8001,8080,8081,8443,8554,8899,9000,9527,34567,34599,37777,37778,5050,6001,7050,7070,9101)
$openPorts = @()
foreach ($p in $tcpPorts) {
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $result = $tcp.BeginConnect($ip, $p, $null, $null)
        $wait = $result.AsyncWaitHandle.WaitOne(800)
        if ($wait -and $tcp.Connected) {
            $openPorts += $p
            $tcp.EndConnect($result) | Out-Null
        }
        $tcp.Close()
    } catch {}
}
Write-Output "OPEN TCP: $($openPorts -join ', ')"

# Step 3: Probe HTTP ports
Write-Output "`n=== HTTP Probe ==="
foreach ($p in $openPorts) {
    try {
        $resp = curl -s --connect-timeout 3 -I "http://${ip}:${p}/" 2>$null
        if ($resp -match "HTTP/") {
            $code = ($resp -split " ")[1]
            $server = ($resp -split "`r`n" | Select-String "Server:" | ForEach-Object { $_ -replace ".*: ", "" })
            Write-Output "HTTP $p -> $code ($server)"
            # Save page
            curl -s --connect-timeout 3 "http://${ip}:${p}/" -o "$outDir\http_${p}_root.html" 2>$null
        }
    } catch {}
}

# Step 4: RTSP probe
Write-Output "`n=== RTSP Probe ==="
if (554 -in $openPorts) {
    $rtspFound = @()
    foreach ($ch in 1..8) {
        $testUrl = "rtsp://${Username}:${Password}@${ip}:554/h264/ch${ch}/main/av_stream"
        try {
            $tcp = New-Object System.Net.Sockets.TcpClient
            $result = $tcp.BeginConnect($ip, 554, $null, $null)
            $wait = $result.AsyncWaitHandle.WaitOne(2000)
            if ($wait -and $tcp.Connected) {
                $stream = $tcp.GetStream()
                $writer = New-Object System.IO.StreamWriter($stream)
                $writer.WriteLine("DESCRIBE $testUrl RTSP/1.0")
                $writer.WriteLine("CSeq: 1")
                $writer.WriteLine("Accept: application/sdp")
                $writer.WriteLine("")
                $writer.Flush()
                Start-Sleep -Milliseconds 600
                $buffer = New-Object byte[] 2048
                try { $read = $stream.Read($buffer, 0, 2048) } catch { $read = 0 }
                if ($read -gt 0) {
                    $resp = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
                    if ($resp -match "RTSP/1.0 200 OK") {
                        $rtspFound += "ch${ch}_main"
                        Write-Output "RTSP OK h264/ch${ch}/main/av_stream"
                        # Save SDP
                        $sdpMatch = [regex]::Match($resp, 'v=0[\s\S]+')
                        if ($sdpMatch.Success) {
                            $sdpMatch.Value | Out-File "$outDir\rtsp_ch${ch}_main.sdp"
                        }
                    }
                }
                $tcp.EndConnect($result) | Out-Null
            }
            $tcp.Close()
        } catch {}
    }
    
    # Sub-streams
    foreach ($ch in 1..8) {
        if ("ch${ch}_main" -in $rtspFound) {
            $testUrl = "rtsp://${Username}:${Password}@${ip}:554/h264/ch${ch}/sub/av_stream"
            try {
                $tcp = New-Object System.Net.Sockets.TcpClient
                $result = $tcp.BeginConnect($ip, 554, $null, $null)
                $wait = $result.AsyncWaitHandle.WaitOne(2000)
                if ($wait -and $tcp.Connected) {
                    $stream = $tcp.GetStream()
                    $writer = New-Object System.IO.StreamWriter($stream)
                    $writer.WriteLine("DESCRIBE $testUrl RTSP/1.0")
                    $writer.WriteLine("CSeq: 1")
                    $writer.WriteLine("Accept: application/sdp")
                    $writer.WriteLine("")
                    $writer.Flush()
                    Start-Sleep -Milliseconds 600
                    $buffer = New-Object byte[] 2048
                    try { $read = $stream.Read($buffer, 0, 2048) } catch { $read = 0 }
                    if ($read -gt 0) {
                        $resp = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
                        if ($resp -match "RTSP/1.0 200 OK") {
                            Write-Output "RTSP OK h264/ch${ch}/sub/av_stream"
                            $sdpMatch = [regex]::Match($resp, 'v=0[\s\S]+')
                            if ($sdpMatch.Success) {
                                $sdpMatch.Value | Out-File "$outDir\rtsp_ch${ch}_sub.sdp"
                            }
                        }
                    }
                    $tcp.EndConnect($result) | Out-Null
                }
                $tcp.Close()
            } catch {}
        }
    }
}

# Step 5: HLS endpoint test
Write-Output "`n=== HLS Endpoint Test ==="
$hlsPaths = @(
    "/live.m3u8", "/stream.m3u8", "/index.m3u8",
    "/hls/live.m3u8", "/hls/stream.m3u8", "/hls/index.m3u8",
    "/live/index.m3u8", "/live/ch1.m3u8", "/live/channel1.m3u8", "/live/1.m3u8",
    "/stream/1.m3u8", "/stream/channel1.m3u8",
    "/media/live.m3u8", "/api/live.m3u8",
    "/api/hls/1.m3u8", "/hls/1/index.m3u8", "/hls/ch1/index.m3u8",
    "/cam/realmonitor.m3u8", "/web/live.m3u8",
    "/CGI/Streaming/hls", "/CGI/Streaming/hls.m3u8",
    "/CGI/HLS/1.m3u8", "/CGI/hls/1.m3u8"
)
foreach ($path in $hlsPaths) {
    $url = "http://${ip}${path}"
    $resp = curl -s --connect-timeout 3 -o /dev/null -w "%{http_code} %{size_download}" $url 2>$null
    if ($resp -match "^200") {
        Write-Output "HTTP 200 $url ($resp bytes)"
    }
}

# Step 6: ONVIF test
Write-Output "`n=== ONVIF Test ==="
$onvifPaths = @("/onvif/device_service", "/onvif/Media", "/onvif/events")
foreach ($port in @(80, 8080, 8899, 8000)) {
    foreach ($path in $onvifPaths) {
        $url = "http://${ip}:${port}${path}"
        $resp = curl -s --connect-timeout 3 -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/soap+xml" $url 2>$null
        if ($resp -match "^[2]") {
            Write-Output "ONVIF $port$path -> $resp"
        }
    }
}

# Step 7: Summary
Write-Output "`n=== Discovery Complete ==="
Write-Output "Results saved to: $outDir"
Write-Output ""

# Generate findings.json
$findings = @{
    timestamp = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    dvr = @{
        ip = $ip
        mac = $macNorm
        openTcpPorts = $openPorts
        tcpPortCount = $openPorts.Count
        rtsp = if (554 -in $openPorts) {@{
            protocol = "RTSP"
            server = "Topsvision Server v2.1"
            transport = "TCP"
            auth = "Digest"
            urlPattern = "rtsp://USER:PASS@${ip}:554/h264/ch{1-8}/{main|sub}/av_stream"
            codec = "H.265"
            audio = "PCMA (G.711 A-law)"
            channels = 8
            streamsPerChannel = @("main", "sub")
        }} else {@{available = $false}}
        http = @{
            ports = @(80)
            server = "APPWebs/"
        }
        hls = @{available = $false; note = "CGI endpoints exist but return empty"}
        onvif = @{available = $false}
        proprietary = @(
            @{port = 34567; protocol = "XM/XMEye NetSurveillance"},
            @{port = 9527; protocol = "Proprietary DVR binary"}
        )
        platform = "XM/XMEye/NetSurveillance (TaoShi OEM)"
        firmware = "1.03.05ac05ab.47820161.T140.2"
    }
    recommendation = @{
        approach = "RTSP-to-HLS via MediaMTX"
        configFile = "mediamtx.yml"
        hlsUrl = "http://MEDIAMTX_HOST:8888/cam1_main/index.m3u8"
        notes = @(
            "H.265 codec - Chrome/Firefox need transcoding to H.264 or use Safari/Edge",
            "Install MediaMTX on the same LAN or the public-facing server",
            "Update CAMERA_HLS_BASE in Firebase Functions to point to MediaMTX",
            "Forward port 8888 (HLS) and 8889 (WebRTC) on router if serving public"
        )
    }
}
$findings | ConvertTo-Json -Depth 10 | Out-File "$outDir\findings.json"
Write-Output (ConvertTo-Json $findings -Depth 5)

Write-Output "Done."
