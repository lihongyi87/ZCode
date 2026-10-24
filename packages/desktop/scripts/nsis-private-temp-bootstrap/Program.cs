// ZCode Windows NSIS bootstrap: extract embedded installer next to a private TEMP
// before NSIS stub self-extracts plugins.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

internal static class Program
{
  private const string Magic = "ZCODE_NSIS_PAYLOAD_V1\n";
  private const string WorkFolderPrefix = "ZCode-CE-nsis-";
  private const int PrepareAttempts = 6;

  [STAThread]
  private static int Main(string[] args)
  {
    string selfPath = Process.GetCurrentProcess().MainModule.FileName;
    string workDir = null;
    List<string> errors = new List<string>();

    try
    {
      CleanupStaleWorkDirs(selfPath);

      for (int attempt = 0; attempt < PrepareAttempts; attempt++)
      {
        workDir = null;
        try
        {
          workDir = CreatePrivateWorkDir(selfPath, attempt, errors);
          string tempDir = Path.Combine(workDir, "tmp");
          string setupPath = Path.Combine(workDir, "setup.exe");
          Directory.CreateDirectory(tempDir);
          TryEnsureMediumIntegrityLevel(workDir, true);
          TryEnsureMediumIntegrityLevel(tempDir, true);
          ProbeWrite(tempDir);
          ExtractPayload(selfPath, setupPath);
          TryEnsureMediumIntegrityLevel(setupPath, false);

          Environment.SetEnvironmentVariable("TEMP", tempDir);
          Environment.SetEnvironmentVariable("TMP", tempDir);

          ProcessStartInfo startInfo = new ProcessStartInfo
          {
            FileName = setupPath,
            Arguments = EscapeArguments(args),
            UseShellExecute = false,
            WorkingDirectory = workDir,
          };
          using (Process child = Process.Start(startInfo))
          {
            if (child == null)
            {
              throw new InvalidOperationException("failed to start embedded NSIS setup");
            }
            child.WaitForExit();
            return child.ExitCode;
          }
        }
        catch (Exception ex)
        {
          errors.Add("attempt#" + attempt + " work=" + (workDir ?? "(null)") + " => " + ex.GetType().Name + ": " + ex.Message);
          TryDeleteDirectory(workDir);
          workDir = null;
          Thread.Sleep(80 * (attempt + 1));
        }
      }

      throw new InvalidOperationException(BuildAggregateMessage(errors));
    }
    catch (Exception ex)
    {
      try
      {
        NativeMessageBox(
          "ZCode installer failed to prepare a private temporary directory.\n\n" + ex.Message,
          "ZCode Installer");
      }
      catch
      {
      }
      return 1;
    }
    finally
    {
      try
      {
        string selfDir = Path.GetDirectoryName(selfPath);
        if (!string.IsNullOrEmpty(selfDir) && !string.IsNullOrEmpty(workDir))
        {
          string installerLog = Path.Combine(workDir, "tmp", "ZCode-installer.log");
          if (File.Exists(installerLog))
          {
            File.Copy(installerLog, Path.Combine(selfDir, "ZCode-installer.last.log"), true);
          }
          string uninstallerLog = Path.Combine(workDir, "tmp", "ZCode-uninstaller.log");
          if (File.Exists(uninstallerLog))
          {
            File.Copy(uninstallerLog, Path.Combine(selfDir, "ZCode-uninstaller.last.log"), true);
          }
        }
      }
      catch
      {
      }
      TryDeleteDirectory(workDir);
    }
  }

  private static string BuildAggregateMessage(List<string> errors)
  {
    StringBuilder sb = new StringBuilder();
    sb.AppendLine("exhausted private TEMP candidates.");
    if (errors.Count == 0)
    {
      sb.Append("no detailed errors captured");
      return sb.ToString();
    }
    int limit = Math.Min(errors.Count, 8);
    for (int i = 0; i < limit; i++)
    {
      sb.AppendLine(errors[i]);
    }
    return sb.ToString();
  }

  private static string CreatePrivateWorkDir(string selfPath, int attempt, List<string> errors)
  {
    string stamp = WorkFolderPrefix +
      DateTime.UtcNow.ToString("yyyyMMddHHmmssfff") + "-" +
      Process.GetCurrentProcess().Id.ToString("x") + "-" +
      attempt.ToString("x") + "-" +
      Guid.NewGuid().ToString("n").Substring(0, 8);

    foreach (string root in EnumerateCandidateRoots(selfPath))
    {
      try
      {
        Directory.CreateDirectory(root);
        string candidate = Path.Combine(root, stamp);
        Directory.CreateDirectory(candidate);
        ProbeWrite(candidate);
        return candidate;
      }
      catch (Exception ex)
      {
        errors.Add("root=" + root + " => " + ex.GetType().Name + ": " + ex.Message);
      }
    }

    throw new InvalidOperationException("no writable private TEMP root available");
  }

  private static IEnumerable<string> EnumerateCandidateRoots(string selfPath)
  {
    // 1) 优先使用用户 LocalAppData 下的正常 Medium 完整性目录。
    // 若安装包位于带有 Low Mandatory Level:(OI)(CI)(NW) 的工作区（例如 Cursor 沙箱目录），
    // 直接把 setup.exe 解压在 exe 同目录会让 setup.exe 继承 Low Mandatory Level，
    // 进而被 Windows 内核 (NtCreateUserProcess) 强制降权为 Low Integrity，导致无法写入 D:\ZCode-CE 等目标安装目录。
    string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    if (!string.IsNullOrWhiteSpace(localAppData))
    {
      yield return Path.Combine(localAppData, "ZCode-CE", "installer-tmp");
      yield return Path.Combine(localAppData, "Temp", "ZCode-CE-nsis");
    }

    // 2) 进程 TEMP / GetTempPath
    foreach (string tempRoot in new string[]
    {
      NormalizeTempRoot(Environment.GetEnvironmentVariable("TEMP")),
      NormalizeTempRoot(Environment.GetEnvironmentVariable("TMP")),
      NormalizeTempRoot(Path.GetTempPath()),
    })
    {
      if (!string.IsNullOrWhiteSpace(tempRoot))
      {
        yield return Path.Combine(tempRoot, "ZCode-CE-nsis");
      }
    }

    // 3) Public / common
    string common = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
    if (!string.IsNullOrWhiteSpace(common))
    {
      yield return Path.Combine(common, "ZCode-CE", "installer-tmp");
    }

    // 4) 兜底：安装包同目录（配合 TryEnsureMediumIntegrityLevel 清除可能继承的 Low Mandatory Label）
    string exeDir = null;
    try
    {
      exeDir = Path.GetDirectoryName(selfPath);
    }
    catch
    {
      exeDir = null;
    }
    if (!string.IsNullOrWhiteSpace(exeDir))
    {
      yield return Path.Combine(exeDir, ".zcode-nsis-tmp");
    }
  }

  private static string NormalizeTempRoot(string value)
  {
    if (string.IsNullOrWhiteSpace(value))
    {
      return null;
    }
    try
    {
      return Path.GetFullPath(value.Trim().TrimEnd('\\', '/'));
    }
    catch
    {
      return null;
    }
  }

  private static void ProbeWrite(string directory)
  {
    string probe = Path.Combine(directory, "zcode-write-probe-" + Guid.NewGuid().ToString("n") + ".tmp");
    using (FileStream stream = new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
    {
      byte[] bytes = Encoding.ASCII.GetBytes("ok");
      stream.Write(bytes, 0, bytes.Length);
      stream.Flush();
    }
    File.Delete(probe);
  }

  private static void CleanupStaleWorkDirs(string selfPath)
  {
    DateTime cutoff = DateTime.UtcNow.AddHours(-1);
    foreach (string root in EnumerateCandidateRoots(selfPath))
    {
      if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
      {
        continue;
      }
      string[] children;
      try
      {
        children = Directory.GetDirectories(root);
      }
      catch
      {
        continue;
      }
      foreach (string child in children)
      {
        try
        {
          string name = Path.GetFileName(child);
          if (name != null &&
            (name.StartsWith(WorkFolderPrefix, StringComparison.OrdinalIgnoreCase) ||
             name.StartsWith(".", StringComparison.Ordinal) ||
             IsHexPidName(name)) &&
            Directory.GetLastWriteTimeUtc(child) < cutoff)
          {
            TryDeleteDirectory(child);
          }
        }
        catch
        {
        }
      }
    }
  }

  private static bool IsHexPidName(string name)
  {
    if (string.IsNullOrEmpty(name) || name.Length > 8)
    {
      return false;
    }
    for (int i = 0; i < name.Length; i++)
    {
      char c = name[i];
      bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
      if (!ok)
      {
        return false;
      }
    }
    return true;
  }

  private static void TryDeleteDirectory(string path)
  {
    if (string.IsNullOrEmpty(path) || !Directory.Exists(path))
    {
      return;
    }
    for (int i = 0; i < 6; i++)
    {
      try
      {
        Directory.Delete(path, true);
        return;
      }
      catch
      {
        Thread.Sleep(40 * (i + 1));
      }
    }
  }

  private static void ExtractPayload(string selfPath, string outputPath)
  {
    byte[] magicBytes = Encoding.ASCII.GetBytes(Magic);
    using (FileStream input = File.OpenRead(selfPath))
    {
      long minimumSize = magicBytes.Length + 8;
      if (input.Length < minimumSize)
      {
        throw new InvalidOperationException("installer bootstrap is truncated");
      }

      input.Seek(-(magicBytes.Length + 8), SeekOrigin.End);
      byte[] trailerMagic = new byte[magicBytes.Length];
      ReadExact(input, trailerMagic, 0, trailerMagic.Length);
      for (int i = 0; i < magicBytes.Length; i++)
      {
        if (trailerMagic[i] != magicBytes[i])
        {
          throw new InvalidOperationException("installer bootstrap magic mismatch");
        }
      }

      byte[] lengthBytes = new byte[8];
      ReadExact(input, lengthBytes, 0, 8);
      long payloadLength = BitConverter.ToInt64(lengthBytes, 0);
      if (payloadLength <= 0 || payloadLength > input.Length)
      {
        throw new InvalidOperationException("installer bootstrap payload length invalid");
      }

      long payloadStart = input.Length - magicBytes.Length - 8 - payloadLength;
      if (payloadStart < 0)
      {
        throw new InvalidOperationException("installer bootstrap payload offset invalid");
      }

      input.Seek(payloadStart, SeekOrigin.Begin);
      using (FileStream output = new FileStream(
        outputPath,
        FileMode.Create,
        FileAccess.Write,
        FileShare.Read))
      {
        byte[] buffer = new byte[1024 * 1024];
        long remaining = payloadLength;
        while (remaining > 0)
        {
          int toRead = (int)Math.Min(buffer.Length, remaining);
          int read = input.Read(buffer, 0, toRead);
          if (read <= 0)
          {
            throw new EndOfStreamException("unexpected EOF while extracting NSIS payload");
          }
          output.Write(buffer, 0, read);
          remaining -= read;
        }
      }
    }
  }

  private static void ReadExact(Stream stream, byte[] buffer, int offset, int count)
  {
    int readTotal = 0;
    while (readTotal < count)
    {
      int read = stream.Read(buffer, offset + readTotal, count - readTotal);
      if (read <= 0)
      {
        throw new EndOfStreamException();
      }
      readTotal += read;
    }
  }

  private static string EscapeArguments(string[] args)
  {
    if (args == null || args.Length == 0)
    {
      return string.Empty;
    }
    StringBuilder builder = new StringBuilder();
    for (int i = 0; i < args.Length; i++)
    {
      if (i > 0)
      {
        builder.Append(' ');
      }
      AppendEscaped(builder, args[i] ?? string.Empty);
    }
    return builder.ToString();
  }

  private static void AppendEscaped(StringBuilder builder, string value)
  {
    bool needsQuotes = false;
    for (int i = 0; i < value.Length; i++)
    {
      char c = value[i];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '"')
      {
        needsQuotes = true;
        break;
      }
    }
    if (!needsQuotes)
    {
      builder.Append(value);
      return;
    }

    builder.Append('"');
    int backslashCount = 0;
    for (int i = 0; i < value.Length; i++)
    {
      char c = value[i];
      if (c == '\\')
      {
        backslashCount++;
        continue;
      }
      if (c == '"')
      {
        builder.Append('\\', backslashCount * 2 + 1);
        builder.Append('"');
        backslashCount = 0;
        continue;
      }
      if (backslashCount > 0)
      {
        builder.Append('\\', backslashCount);
        backslashCount = 0;
      }
      builder.Append(c);
    }
    if (backslashCount > 0)
    {
      builder.Append('\\', backslashCount * 2);
    }
    builder.Append('"');
  }

  private static void TryEnsureMediumIntegrityLevel(string path, bool isDirectory)
  {
    if (string.IsNullOrEmpty(path))
    {
      return;
    }
    try
    {
      string sddl = isDirectory ? "S:(ML;OICI;NW;;;ME)" : "S:(ML;;NW;;;ME)";
      IntPtr sd = IntPtr.Zero;
      uint sdSize = 0;
      if (ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out sdSize) && sd != IntPtr.Zero)
      {
        try
        {
          bool saclPresent = false;
          IntPtr sacl = IntPtr.Zero;
          bool saclDefaulted = false;
          if (GetSecurityDescriptorSacl(sd, out saclPresent, out sacl, out saclDefaulted) && saclPresent)
          {
            // SE_FILE_OBJECT = 1, LABEL_SECURITY_INFORMATION = 0x00000010
            SetNamedSecurityInfoW(path, 1, 0x00000010u, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
          }
        }
        finally
        {
          LocalFree(sd);
        }
      }
    }
    catch
    {
    }
  }

  [System.Runtime.InteropServices.DllImport("advapi32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
  private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
    string StringSecurityDescriptor,
    uint StringSDRevision,
    out IntPtr SecurityDescriptor,
    out uint SecurityDescriptorSize);

  [System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool GetSecurityDescriptorSacl(
    IntPtr pSecurityDescriptor,
    out bool lpbSaclPresent,
    out IntPtr pSacl,
    out bool lpbSaclDefaulted);

  [System.Runtime.InteropServices.DllImport("advapi32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
  private static extern uint SetNamedSecurityInfoW(
    string pObjectName,
    int ObjectType,
    uint SecurityInfo,
    IntPtr psidOwner,
    IntPtr psidGroup,
    IntPtr pDacl,
    IntPtr pSacl);

  [System.Runtime.InteropServices.DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr hMem);

  [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
  private static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

  private static void NativeMessageBox(string text, string caption)
  {
    MessageBoxW(IntPtr.Zero, text, caption, 0x00000010u);
  }
}
