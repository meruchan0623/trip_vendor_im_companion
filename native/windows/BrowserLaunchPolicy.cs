using System.Net;
using System.IO;
using System.Text.RegularExpressions;

internal sealed record BrowserProcessProof(uint Pid, long StartedTicks, uint ParentPid, string Executable, string Command);

/** Pure ownership policy. A URL or a PID by itself never authorizes a window mutation. */
internal sealed class BrowserLaunchPolicy
{
    internal readonly string Profile;
    internal readonly string AppUrl;
    internal readonly string Executable;
    internal readonly Dictionary<uint, long> Owned = new();
    internal uint SpawnPid;
    internal long SpawnStartedTicks;
    internal long? SpawnExitedTicks;

    internal BrowserLaunchPolicy(string profile, string appUrl, string executable)
    {
        Profile = Path.GetFullPath(profile).TrimEnd('\\', '/'); AppUrl = appUrl; Executable = Path.GetFullPath(executable);
        if (!ApprovedUrl(appUrl)) throw new ArgumentException("browser_url_denied");
    }
    internal static bool ApprovedUrl(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var url) || url.Scheme != "https" || url.Host != "csagent.tsim.tech" || url.Port != 443 || url.AbsolutePath != "/embed/operator" || url.UserInfo != "" || url.Fragment != "") return false;
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string part in url.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var pair = part.Split('=', 2); string key = WebUtility.UrlDecode(pair[0]), content = WebUtility.UrlDecode(pair.Length == 2 ? pair[1] : "");
            if (!new[] { "source", "identifier", "identifierType", "requestId" }.Contains(key) || !parameters.TryAdd(key, content)) return false;
        }
        if (!parameters.TryGetValue("source", out var source) || source != "travel-merchant-companion") return false;
        if (parameters.Count == 1) return true; // Anonymous controlled smoke/login route.
        return parameters.Count == 4 && parameters.TryGetValue("identifier", out var identifier) && identifier.Trim().Length > 0 && identifier.Length <= 128 && identifier.IndexOfAny(new[] { '\r', '\n', '\0' }) < 0
            && parameters.TryGetValue("identifierType", out var type) && new[] { "order_number", "iccid", "eiccid" }.Contains(type)
            && parameters.TryGetValue("requestId", out var requestId) && Guid.TryParseExact(requestId, "D", out _);
    }
    internal bool Matches(BrowserProcessProof process, bool exactUrl = false)
    {
        if (!string.Equals(process.Executable, Executable, StringComparison.OrdinalIgnoreCase)) return false;
        var arguments = Regex.Matches(process.Command, "(?:\"[^\"]*\"|[^\\s\"]+)+").Select(m => m.Value.Replace("\"", "")).ToArray();
        var profiles = arguments.Where(a => a.StartsWith("--user-data-dir=", StringComparison.OrdinalIgnoreCase)).ToArray();
        var apps = arguments.Where(a => a.StartsWith("--app=", StringComparison.OrdinalIgnoreCase)).ToArray();
        return !arguments.Any(a => a.StartsWith("--type=", StringComparison.OrdinalIgnoreCase)) && profiles.Length == 1 && apps.Length == 1
            && string.Equals(profiles[0][16..].TrimEnd('\\', '/'), Profile, StringComparison.OrdinalIgnoreCase)
            && ApprovedUrl(apps[0][6..]) && (!exactUrl || apps[0][6..] == AppUrl);
    }
    internal void RecordBroker(BrowserProcessProof process) { if (!Matches(process)) throw new ArgumentException("browser_broker_denied"); Owned.Add(process.Pid, process.StartedTicks); }
    internal void RecordSpawn(uint pid, long ticks) { SpawnPid = pid; SpawnStartedTicks = ticks; Owned[pid] = ticks; }
    internal bool Accept(BrowserProcessProof process)
    {
        if (!Matches(process)) return false;
        if (Owned.TryGetValue(process.Pid, out long start)) return start == process.StartedTicks;
        if (SpawnPid == 0) return false;
        // Broker handoff to a pre-existing process is accepted only from the pre-spawn snapshot.
        // A newly created successor must have been born during the exact launch PID's lifetime.
        if (!Matches(process, true) || process.ParentPid != SpawnPid || process.StartedTicks < SpawnStartedTicks || (SpawnExitedTicks.HasValue && process.StartedTicks > SpawnExitedTicks.Value)) return false;
        Owned.Add(process.Pid, process.StartedTicks); return true;
    }
}
