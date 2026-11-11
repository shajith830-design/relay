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
  <prosody rate="-3%">
    A great customer experience doesn't start at launch. <break time="350ms"/> It starts with a clear path forward.
    <break time="2200ms"/>
    Relay brings every onboarding step, owner, and handoff into one smooth rhythm.
    <break time="2200ms"/>
    Give customers a clear view of what comes next, and your team a workflow it can reuse.
    <break time="2200ms"/>
    Keep everyone aligned with visible owners, timely reminders, and meaningful next actions.
    <break time="2200ms"/>
    See progress across your implementations, spot what needs attention, and keep momentum going.
    <break time="2200ms"/>
    Make every handoff feel effortless. <break time="300ms"/> Relay.
    <break time="400ms"/> Book a demo at relay automation dot tech.
  </prosody>
</speak>
'@

  $synth.SpeakSsml($script)
} finally {
  $synth.Dispose()
}

Write-Output "Created marketing voiceover: $OutputPath"
