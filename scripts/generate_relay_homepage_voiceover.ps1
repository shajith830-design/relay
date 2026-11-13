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
    throw "Install a Microsoft Mark or Microsoft Zira English desktop voice to generate the Relay homepage voiceover."
  }

  $synth.Rate = -1
  $synth.Volume = 100
  $synth.SetOutputToWaveFile($OutputPath)

  $script = @'
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
  <prosody rate="-3%">
    The contract is signed. <break time="450ms"/> Now every handoff matters.
    <break time="600ms"/>
    Relay connects requests, owners, and next actions.
    <break time="500ms"/>
    Reuse a checked workflow through launch.
    <break time="500ms"/>
    Give customers clear next steps. Collect setup details.
    <break time="500ms"/>
    Find gaps. Follow up. Keep launches moving.
    <break time="500ms"/>
    Make every next step clear.
  </prosody>
</speak>
'@

  $synth.SpeakSsml($script)
} finally {
  $synth.Dispose()
}

Write-Output "Created homepage voiceover: $OutputPath"
