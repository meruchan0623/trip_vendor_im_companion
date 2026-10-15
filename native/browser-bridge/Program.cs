using System.Buffers.Binary;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;

// Native messaging permits this exact extension only; never print diagnostics to stdout.
const string origin = "chrome-extension://iiepfpjonkacmepbnhgacllpipibhphh/";
const int limit = 262144;
if (args.Length < 1 || args[0] != origin) return 1;
var discovery = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TravelMerchantCompanion", "browser-bridge", "session.json");
var input = Console.OpenStandardInput(); var output = Console.OpenStandardOutput();
using var lifetime = new CancellationTokenSource();
var writeGate = new SemaphoreSlim(1);
NamedPipeClientStream? connection = null;
var connectionGate = new SemaphoreSlim(1);
bool Valid(JsonElement value, bool fromBrowser) {
  if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("type", out var type) || !value.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String || !Guid.TryParseExact(id.GetString(), "D", out _)) return false;
  if (fromBrowser) return type.GetString() == "response" && value.TryGetProperty("ok", out var ok) && (ok.ValueKind == JsonValueKind.True || ok.ValueKind == JsonValueKind.False) && value.EnumerateObject().All(p => new[]{"type","id","ok","value","error"}.Contains(p.Name));
  if (type.GetString() == "cancel") return value.EnumerateObject().All(p => new[]{"type","id"}.Contains(p.Name));
  return type.GetString() == "request" && value.TryGetProperty("action", out var action) && new[]{"sync","translate","openLogin","openOrder","placeOrder","closeOrder"}.Contains(action.GetString()) && value.TryGetProperty("payload", out var payload) && payload.ValueKind == JsonValueKind.Object && value.EnumerateObject().All(p => new[]{"type","id","action","payload"}.Contains(p.Name));
}
async Task SendBrowser(byte[] bytes) {
  if (bytes.Length > limit) throw new IOException();
  await writeGate.WaitAsync(lifetime.Token);
  try { var header = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(header, bytes.Length); await output.WriteAsync(header, lifetime.Token); await output.WriteAsync(bytes, lifetime.Token); await output.FlushAsync(lifetime.Token); }
  finally { writeGate.Release(); }
}
async Task PipeLoop() {
  while (!lifetime.IsCancellationRequested) {
    var established = false;
    try {
      var file = await File.ReadAllTextAsync(discovery, lifetime.Token);
      if (file.Length > 2048) throw new IOException();
      using var doc = JsonDocument.Parse(file); var root = doc.RootElement;
      var path = root.GetProperty("pipe").GetString()!; var capability = root.GetProperty("capability").GetString()!;
      const string prefix = @"\\.\pipe\travel-merchant-browser-";
      if (root.GetProperty("version").GetInt32() != 1 || !path.StartsWith(prefix, StringComparison.Ordinal) || !Guid.TryParseExact(path[prefix.Length..], "D", out _) || capability.Length != 64 || capability.Any(c => !"0123456789abcdef".Contains(c))) throw new IOException();
      using var pipe = new NamedPipeClientStream(".", path[@"\\.\pipe\".Length..], PipeDirection.InOut, PipeOptions.Asynchronous, System.Security.Principal.TokenImpersonationLevel.Identification);
      await pipe.ConnectAsync(1500, lifetime.Token);
      var hello = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new{type="hello",capability}) + "\n"); await pipe.WriteAsync(hello,lifetime.Token); await pipe.FlushAsync(lifetime.Token);
      connection = pipe; established = true;
      // Read bounded UTF-8 lines: StreamReader.ReadLine would allocate before enforcing the limit.
      var bytes = new byte[4096]; using var frame = new MemoryStream();
      for (;;) {
        var count = await pipe.ReadAsync(bytes, lifetime.Token); if (count == 0) throw new EndOfStreamException();
        for(var i=0;i<count;i++) {
          if(bytes[i] == 10) { var message = frame.ToArray(); frame.SetLength(0); using var parsed = JsonDocument.Parse(message); if(!Valid(parsed.RootElement,false)) throw new IOException(); await SendBrowser(message); }
          else { if(frame.Length >= limit) throw new IOException(); frame.WriteByte(bytes[i]); }
        }
      }
    } catch (OperationCanceledException) { break; }
    catch {
      // A previously authenticated app connection vanished. Close native messaging too,
      // so the extension cancels page requests and removes only its owned order popups.
      // Exit is deliberate: a pending Windows stdin read may not observe cancellation.
      if (established) Environment.Exit(0);
      /* App may not be running yet. Existing browser login is untouched. */
    }
    finally { connection = null; }
    try { await Task.Delay(1000,lifetime.Token); } catch(OperationCanceledException) { break; }
  }
}
var relay = PipeLoop();
try {
  var header = new byte[4];
  for (;;) {
    var first = await input.ReadAsync(header.AsMemory(0,4),lifetime.Token); if(first == 0) break;
    if(first < 4) await input.ReadExactlyAsync(header.AsMemory(first,4-first),lifetime.Token);
    var size = BinaryPrimitives.ReadInt32LittleEndian(header); if(size <= 0 || size > limit) break;
    var message = new byte[size]; await input.ReadExactlyAsync(message,lifetime.Token);
    using var parsed = JsonDocument.Parse(message); if(!Valid(parsed.RootElement,true)) break;
    var pipe = connection; if(pipe == null) continue;
    await connectionGate.WaitAsync(lifetime.Token);
    try { await pipe.WriteAsync(message,lifetime.Token); await pipe.WriteAsync(new byte[]{10},lifetime.Token); await pipe.FlushAsync(lifetime.Token); }
    finally { connectionGate.Release(); }
  }
} catch { /* Browser disconnected or malformed framing. */ }
finally { lifetime.Cancel(); connection?.Dispose(); try { await relay; } catch {} }
return 0;
