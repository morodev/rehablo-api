param(
    [Parameter(Mandatory = $true)][string]$XmlDirectory,
    [string]$SchemaDirectory = (Join-Path $PSScriptRoot '../src/modules/invoice/utils/fixtures')
)
$ErrorActionPreference = 'Stop'
$readSettings = New-Object System.Xml.XmlReaderSettings
$readSettings.DtdProcessing = [System.Xml.DtdProcessing]::Parse
$readSettings.XmlResolver = $null
$schemas = New-Object System.Xml.Schema.XmlSchemaSet
$schemas.XmlResolver = $null
$signature = [System.Xml.XmlReader]::Create((Join-Path $SchemaDirectory 'xmldsig-core-schema.xsd'), $readSettings)
try { [void]$schemas.Add('http://www.w3.org/2000/09/xmldsig#', $signature) } finally { $signature.Close() }
$main = [System.Xml.XmlReader]::Create((Join-Path $SchemaDirectory 'Schema_VFPR12_v1.2.3.xsd'), $readSettings)
try { [void]$schemas.Add('http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2', $main) } finally { $main.Close() }
$schemas.Compile()
$failures = New-Object 'System.Collections.Generic.List[string]'
$settings = New-Object System.Xml.XmlReaderSettings
$settings.Schemas.Add($schemas)
$settings.ValidationType = [System.Xml.ValidationType]::Schema
$settings.XmlResolver = $null
$settings.add_ValidationEventHandler({ param($sender, $eventArgs) $failures.Add($eventArgs.Message) })
$files = @(Get-ChildItem -LiteralPath $XmlDirectory -Filter '*.xml' -File)
if ($files.Count -eq 0) { throw 'No synthetic XML fixtures found' }
foreach ($file in $files) {
    $reader = [System.Xml.XmlReader]::Create($file.FullName, $settings)
    try { while ($reader.Read()) {} } catch { $failures.Add($file.Name + ': ' + $_.Exception.Message) } finally { $reader.Close() }
}
if ($failures.Count) { throw ($failures -join [Environment]::NewLine) }
Write-Output ($files.Count.ToString() + ' synthetic invoices validated against official FatturaPA XSD 1.2.3.')
