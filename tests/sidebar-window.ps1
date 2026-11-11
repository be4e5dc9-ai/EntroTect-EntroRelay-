param([int]$AppProcessId)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PreviewWindow {
    public struct Rect { public int Left, Top, Right, Bottom; }
    public struct Point { public int X, Y; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string title);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr parent, Point point, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@

[void][PreviewWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
$windowHandle = (Get-Process -Id $AppProcessId -ErrorAction Stop).MainWindowHandle
$windowRect = New-Object 'PreviewWindow+Rect'
$clientOrigin = New-Object 'PreviewWindow+Point'
[void][PreviewWindow]::GetClientRect($windowHandle, [ref]$windowRect)
[void][PreviewWindow]::ClientToScreen($windowHandle, [ref]$clientOrigin)
$child = [IntPtr]::Zero
$rect = New-Object 'PreviewWindow+Rect'
while ($true) {
    $child = [PreviewWindow]::FindWindowEx($windowHandle, $child, 'WRY_WEBVIEW', $null)
    if ($child -eq [IntPtr]::Zero) { break }
    [void][PreviewWindow]::GetWindowRect($child, [ref]$rect)
    $width = $rect.Right - $rect.Left
    if ($width -ge $windowRect.Right) { continue }
    $x = $rect.Left - $clientOrigin.X
    $y = $rect.Top - $clientOrigin.Y
    $height = $rect.Bottom - $rect.Top
    $center = New-Object 'PreviewWindow+Point'
    $center.X = $x + [int]($width / 2)
    $center.Y = $y + [int]($height / 2)
    [pscustomobject]@{
        visible = [PreviewWindow]::IsWindowVisible($child)
        onTop = [PreviewWindow]::ChildWindowFromPointEx($windowHandle, $center, 1) -eq $child
        x = $x
        y = $y
        width = $width
        height = $height
    } | ConvertTo-Json -Compress
    exit
}
'null'
