param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  $voices = @($synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
  if ($voices -contains "Microsoft Mark") {
    $synth.SelectVoice("Microsoft Mark")
  } elseif ($voices -contains "Microsoft Zira Desktop") {
    $synth.SelectVoice("Microsoft Zira Desktop")
  } elseif ($voices -contains "Microsoft Zira") {
    $synth.SelectVoice("Microsoft Zira")
  } else {
    throw "Install a Microsoft Mark or Microsoft Zira English desktop voice to generate the Relay marketing voiceover."
  }

  $synth.Rate = -1
  $synth.Volume = 100
  $synth.SetOutputToWaveFile($OutputPath)

  $script = @'
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
  <prosody rate="-2%">
    Every new customer deserves a clear path from kickoff to go-live.
    <break time="250ms"/>
    Relay brings your team, customer requests, and next steps into one shared view.
    <break time="250ms"/>
    Fewer missed handoffs. Less chasing. More momentum.
    <break time="250ms"/>
    Relay. Make every launch a clearer start.
    <break time="250ms"/>
    Explore Relay at relay automation dot tech.
  </prosody>
</speak>
'@

  $synth.SpeakSsml($script)
} finally {
  $synth.Dispose()
}

Write-Output "Created marketing voiceover: $OutputPath"
